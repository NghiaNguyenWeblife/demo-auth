import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtUser } from '../auth/user.decorator';
import { MailService } from '../mail/mail.service';
import { inviteAcceptUrl } from './invite-url';
import { JsonStore } from './json-store';

export type WorkspaceRole = 'owner' | 'member';
export const WORKSPACE_ROLES: WorkspaceRole[] = ['owner', 'member'];

/** data/workspaces.json */
export interface Workspace {
  workspaceId: number;
  name: string;
}

/** data/member_roles.json */
export interface MemberRole {
  workspaceId: number;
  /** FA user id; null until the invite is accepted. */
  userId: string | null;
  email: string;
  role: WorkspaceRole;
  status: 'pending' | 'active';
  inviteToken: string | null;
  inviteExpiresAt: string | null;
}

export interface UserWorkspace extends Workspace {
  role: WorkspaceRole;
}

export interface Invite extends MemberRole {
  workspaceName: string;
}

export type AcceptResult =
  | { workspaceId: number }
  | { failure: 'not-found' | 'unverified' | 'email-mismatch' };

const WORKSPACES = 'workspaces.json';
const MEMBER_ROLES = 'member_roles.json';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ADJECTIVES = ['Blue', 'Swift', 'Quiet', 'Golden', 'Bright', 'Crimson', 'Silver', 'Lucky', 'Brave', 'Misty'];
const NOUNS = ['Falcon', 'Harbor', 'Maple', 'Comet', 'Lantern', 'River', 'Summit', 'Orchard', 'Fox', 'Meadow'];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export function normalizeEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

function isLiveInvite(m: MemberRole): boolean {
  return (
    m.status === 'pending' &&
    Boolean(m.inviteToken) &&
    (!m.inviteExpiresAt || Date.parse(m.inviteExpiresAt) > Date.now())
  );
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly store: JsonStore,
    private readonly mail: MailService,
  ) {}

  /**
   * New YUILINK registration → own workspace. Skipped when the user already
   * owns one (e.g. registration removed and added again).
   */
  async createOwnedWorkspace(userId: string, email: string | undefined) {
    await this.store.exclusive(async () => {
      const workspaces = await this.store.read<Workspace>(WORKSPACES);
      const members = await this.store.read<MemberRole>(MEMBER_ROLES);
      if (
        members.some(
          m =>
            m.userId === userId && m.role === 'owner' && m.status === 'active',
        )
      ) {
        return;
      }

      let workspaceId = Date.now();
      while (workspaces.some(w => w.workspaceId === workspaceId)) {
        workspaceId++;
      }
      workspaces.push({ workspaceId, name: `${pick(ADJECTIVES)} ${pick(NOUNS)}` });
      members.push({
        workspaceId,
        userId,
        email: normalizeEmail(email),
        role: 'owner',
        status: 'active',
        inviteToken: null,
        inviteExpiresAt: null,
      });
      await this.store.write(WORKSPACES, workspaces);
      await this.store.write(MEMBER_ROLES, members);
    });
  }

  /** Invited users join the inviter's workspace instead of getting their own. */
  async hasPendingInvite(email: string | undefined): Promise<boolean> {
    const target = normalizeEmail(email);
    if (!target) return false;
    const members = await this.store.read<MemberRole>(MEMBER_ROLES);
    return members.some(m => m.email === target && isLiveInvite(m));
  }

  async listForUser(userId: string): Promise<UserWorkspace[]> {
    const workspaces = await this.store.read<Workspace>(WORKSPACES);
    const members = await this.store.read<MemberRole>(MEMBER_ROLES);
    return members
      .filter(m => m.userId === userId && m.status === 'active')
      .map(m => {
        const w = workspaces.find(w => w.workspaceId === m.workspaceId);
        return w && { ...w, role: m.role };
      })
      .filter(Boolean);
  }

  /** Active members and live invites, owners first. */
  async listMembers(workspaceId: number): Promise<MemberRole[]> {
    const members = await this.store.read<MemberRole>(MEMBER_ROLES);
    return members
      .filter(
        m =>
          m.workspaceId === workspaceId &&
          (m.status === 'active' || isLiveInvite(m)),
      )
      .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'));
  }

  async findInvite(token: string | undefined): Promise<Invite | null> {
    if (!token) return null;
    const invites = await this.liveInvites(m => m.inviteToken === token);
    return invites[0] ?? null;
  }

  /** Live invites addressed to this email (dashboard "Pending invitations"). */
  async listInvitesForEmail(email: string | undefined): Promise<Invite[]> {
    const target = normalizeEmail(email);
    if (!target) return [];
    return this.liveInvites(m => m.email === target);
  }

  private async liveInvites(
    match: (m: MemberRole) => boolean,
  ): Promise<Invite[]> {
    const workspaces = await this.store.read<Workspace>(WORKSPACES);
    const members = await this.store.read<MemberRole>(MEMBER_ROLES);
    return members
      .filter(m => isLiveInvite(m) && match(m))
      .map(m => {
        const w = workspaces.find(w => w.workspaceId === m.workspaceId);
        return w && { ...m, workspaceName: w.name };
      })
      .filter(Boolean);
  }

  /**
   * Owner invites `email`. A still-pending invite for the same email gets a
   * new token/expiry/role and is sent again (same as apps/backend).
   */
  async invite(
    actor: JwtUser,
    workspaceId: number,
    rawEmail: string | undefined,
    rawRole: string | undefined,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(email)) {
      throw new BadRequestException('Invalid email address');
    }
    const role = rawRole as WorkspaceRole;
    if (!WORKSPACE_ROLES.includes(role)) {
      throw new BadRequestException('Invalid role');
    }
    if (email === normalizeEmail(actor.email)) {
      throw new BadRequestException('You cannot invite yourself');
    }

    const { workspace, token } = await this.store.exclusive(async () => {
      const workspaces = await this.store.read<Workspace>(WORKSPACES);
      const members = await this.store.read<MemberRole>(MEMBER_ROLES);

      const workspace = workspaces.find(w => w.workspaceId === workspaceId);
      if (!workspace) throw new NotFoundException('Workspace not found');
      const isOwner = members.some(
        m =>
          m.workspaceId === workspaceId &&
          m.userId === actor.sub &&
          m.status === 'active' &&
          m.role === 'owner',
      );
      if (!isOwner) {
        throw new ForbiddenException('Only the owner can invite members');
      }

      const token = randomUUID();
      const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      const existing = members.find(
        m => m.workspaceId === workspaceId && m.email === email,
      );
      if (existing?.status === 'active') {
        throw new BadRequestException(`${email} is already a member`);
      }
      if (existing) {
        Object.assign(existing, { role, inviteToken: token, inviteExpiresAt });
      } else {
        members.push({
          workspaceId,
          userId: null,
          email,
          role,
          status: 'pending',
          inviteToken: token,
          inviteExpiresAt,
        });
      }
      await this.store.write(MEMBER_ROLES, members);
      return { workspace, token };
    });

    try {
      await this.mail.sendWorkspaceInvite({
        to: email,
        inviterName: (actor.name as string) || actor.email || 'A team member',
        workspaceName: workspace.name,
        role,
        acceptUrl: inviteAcceptUrl(token),
      });
    } catch (e) {
      // The invite row stays pending; inviting the same email again resends.
      // 4xx on purpose: the UI shows it, and SMTP details stay in the log.
      this.logger.error(`Invite mail to ${email} failed: ${(e as Error).message}`);
      throw new HttpException(
        'Invitation saved, but the email could not be sent. Try inviting again later.',
        424,
      );
    }
  }

  acceptByToken(token: string, user: JwtUser): Promise<AcceptResult> {
    return this.accept(user, m => m.inviteToken === token);
  }

  acceptForEmail(workspaceId: number, user: JwtUser): Promise<AcceptResult> {
    const email = normalizeEmail(user.email);
    return this.accept(
      user,
      m => m.workspaceId === workspaceId && m.email === email,
    );
  }

  /**
   * Only the owner of the invited mailbox may accept: the id_token's email
   * must be verified by FA and equal the invited email.
   */
  private accept(
    user: JwtUser,
    match: (m: MemberRole) => boolean,
  ): Promise<AcceptResult> {
    return this.store.exclusive(async () => {
      const members = await this.store.read<MemberRole>(MEMBER_ROLES);
      const invite = members.find(m => isLiveInvite(m) && match(m));
      if (!invite) return { failure: 'not-found' as const };
      if (!user.email_verified) return { failure: 'unverified' as const };
      if (normalizeEmail(user.email) !== invite.email) {
        return { failure: 'email-mismatch' as const };
      }

      const alreadyMember = members.some(
        m =>
          m.workspaceId === invite.workspaceId &&
          m.userId === user.sub &&
          m.status === 'active',
      );
      if (alreadyMember) {
        members.splice(members.indexOf(invite), 1);
      } else {
        Object.assign(invite, {
          userId: user.sub,
          status: 'active',
          inviteToken: null,
          inviteExpiresAt: null,
        });
      }
      await this.store.write(MEMBER_ROLES, members);
      return { workspaceId: invite.workspaceId };
    });
  }
}
