import { JwtUser } from './auth/user.decorator';
import type {
  Invite,
  MemberRole,
  UserWorkspace,
} from './workspace/workspace.service';
import { inviteAcceptUrl } from './workspace/invite-url';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function loggedOutView(): string {
  return page(
    'Login',
    `
    <p>You are not logged in.</p>
    <div class="actions">
      <!-- Tries a silent refresh first, then falls back to the FA login page. -->
      <a class="btn" href="/auth/refresh-redirect">Login</a>
      <a class="btn secondary" href="/signup">Sign up (new user)</a>
      <a class="btn secondary" href="/signup2">Sign up (option 2)</a>
    </div>
    <p class="muted">Already have a WebLiFE account? Use Login — you will be
       asked to register for YUILINK afterwards.</p>`,
  );
}

/** Authenticated with FusionAuth, but no YUILINK registration yet. */
export function pendingRegistrationView(email: string | undefined): string {
  return page(
    'Register for YUILINK',
    `
    <p>Your account <b>${esc(email)}</b> is not registered for YUILINK.</p>
    <p>Register to start using YUILINK with the same password.</p>
    <div class="actions">
      <form method="post" action="/auth/yuilink-register">
        <button type="submit">Register</button>
      </form>
      <a class="btn secondary" href="/auth/pending-cancel">Cancel</a>
    </div>`,
  );
}

export function unverifiedView(user: JwtUser): string {
  return page(
    'Verify your email',
    `
    <p>Signed in as <b>${esc(user.email)}</b>, but this email address is
       <b>not verified</b>, so you cannot use YUILINK yet.</p>
    <p>Click the link in the verification email, then press
       <i>I have verified</i> to reload your session.</p>
    <div class="actions">
      <button onclick="resend()">Resend verification email</button>
      <button class="secondary" onclick="refresh()">I have verified</button>
      <a class="btn secondary" href="/auth/fa-logout">Logout</a>
    </div>
    <pre id="out"></pre>`,
  );
}

export interface DashboardData {
  workspaces: UserWorkspace[];
  current?: UserWorkspace;
  members: MemberRole[];
  /** Pending invites addressed to this user's email. */
  invites: Invite[];
}

export function homeView(user: JwtUser, data: DashboardData): string {
  const exp =
    typeof user.exp === 'number' ? new Date(user.exp * 1000).toISOString() : '';
  const { workspaces, current, members, invites } = data;

  const inviteSection = invites.length
    ? `
    <section class="card card-highlight">
      <div class="card-head">
        <h2>Pending invitations</h2>
        <span class="count">${invites.length}</span>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Workspace</th><th>Role</th><th></th></tr>
        ${invites
          .map(
            i => `<tr>
          <td>${esc(i.workspaceName)}</td>
          <td>${roleTag(i.role)}</td>
          <td class="right"><button onclick="acceptInvite(${i.workspaceId})">Accept</button></td>
        </tr>`,
          )
          .join('')}
      </table></div>
    </section>`
    : '';

  const workspaceSection = workspaces.length
    ? `<nav class="ws">
      ${workspaces
        .map(
          w =>
            `<a href="/dashboard?workspaceId=${w.workspaceId}"${
              w.workspaceId === current?.workspaceId ? ' class="active"' : ''
            }><span class="ws-icon">${esc(initial(w.name))}</span><span class="ws-name">${esc(w.name)}</span>${roleTag(w.role)}</a>`,
        )
        .join('')}
    </nav>`
    : '<p class="muted">You are not a member of any workspace.</p>';

  const memberSection = current
    ? `
    <section class="card">
      <div class="card-head">
        <div>
          <h2>Members</h2>
          <p class="muted">${esc(current.name)} · ${members.length} member${members.length === 1 ? '' : 's'}</p>
        </div>
        ${current.role === 'owner' ? '<button onclick="openInvite()">+ Invite</button>' : ''}
      </div>
      <div class="table-wrap"><table>
        <tr><th>Email</th><th>Role</th><th>Status</th></tr>
        ${members
          .map(
            m => `<tr>
          <td><span class="avatar sm">${esc(initial(m.email))}</span>${esc(m.email)}${m.userId === user.sub ? ' <span class="muted">(you)</span>' : ''}</td>
          <td>${roleTag(m.role)}</td>
          <td>${m.status === 'pending' ? '<span class="tag pending">pending</span>' : '<span class="tag active">active</span>'}</td>
        </tr>`,
          )
          .join('')}
      </table></div>
      ${current.role === 'owner' ? inviteDialog(current.workspaceId) : ''}
    </section>`
    : '';

  return page(
    'Dashboard',
    `
    ${inviteSection}
    <div class="grid">
      <aside class="card">
        <h2>Workspaces</h2>
        ${workspaceSection}
      </aside>
      <div class="stack">
        ${memberSection}
        <section class="card">
          <details>
            <summary>Session · token expires at ${esc(exp)}</summary>
            <div class="actions">
              <button class="secondary" onclick="refresh()">Refresh token</button>
            </div>
            <pre>${esc(JSON.stringify(user, null, 2))}</pre>
          </details>
          <pre id="out"></pre>
        </section>
      </div>
    </div>`,
    { wide: true, user },
  );
}

function initial(s: string | undefined): string {
  return (s ?? '?').trim().charAt(0).toUpperCase() || '?';
}

function roleTag(role: string): string {
  return `<span class="tag ${role === 'owner' ? 'owner' : 'member'}">${esc(role)}</span>`;
}

function inviteDialog(workspaceId: number): string {
  return `
    <dialog id="invite-dialog">
      <form class="form" data-workspace-id="${workspaceId}" onsubmit="submitInvite(event)">
        <h2>Invite member</h2>
        <label>Email <input name="email" type="email" required></label>
        <label>Role
          <select name="role">
            <option value="member" selected>member</option>
            <option value="owner">owner</option>
          </select>
        </label>
        <p id="invite-error" class="error"></p>
        <div class="actions">
          <button type="submit">Send invitation</button>
          <button type="button" class="secondary" onclick="closeInvite()">Cancel</button>
        </div>
      </form>
    </dialog>`;
}

/** FA login with the email prefilled; back to the invite link afterwards if given. */
function loginUrl(email: string, inviteToken?: string): string {
  const params = new URLSearchParams({ login_hint: email });
  if (inviteToken) params.set('redirect', inviteAcceptUrl(inviteToken));
  return `/auth/fusionauth/login?${params.toString()}`;
}

/** Invite link opened without a session. */
export function inviteLandingView(invite: Invite): string {
  return page(
    'Invitation',
    `
    <p>You have been invited to the workspace <b>${esc(invite.workspaceName)}</b>
       as <b>${esc(invite.role)}</b>.</p>
    <p>The invitation was sent to <b>${esc(invite.email)}</b>. Log in or sign up
       with this email address to accept it.</p>
    <div class="actions">
      <a class="btn" href="${esc(loginUrl(invite.email, invite.inviteToken))}">Login</a>
      <a class="btn secondary" href="/signup?invite=${encodeURIComponent(invite.inviteToken)}">Sign up (new user)</a>
    </div>`,
  );
}

/** Logged in, but not as the invited email (e.g. FA SSO picked another account). */
export function inviteWrongAccountView(invite: Invite, user: JwtUser): string {
  return page(
    'Wrong account',
    `
    <p>This invitation to <b>${esc(invite.workspaceName)}</b> was sent to
       <b>${esc(invite.email)}</b>, but you are logged in as
       <b>${esc(user.email)}</b>.</p>
    <p>Log out, then log in with <b>${esc(invite.email)}</b>. The invitation
       is listed on that account's dashboard.</p>
    <div class="actions">
      <a class="btn" href="/auth/fa-logout">Log in with another account</a>
      <a class="btn secondary" href="/dashboard">Go to dashboard</a>
    </div>`,
  );
}

export function inviteInvalidView(): string {
  return page(
    'Invitation',
    `
    <p>This invitation is invalid, expired, or has already been accepted.</p>
    <div class="actions">
      <a class="btn" href="/">Continue</a>
    </div>`,
  );
}

export interface SignupValues {
  email?: string;
  /** Invite token: kept through the form so Login returns to the invite. */
  invite?: string;
  firstName?: string;
  lastName?: string;
}

export function signupDoneView(email: string, inviteToken?: string): string {
  return page(
    'Sign up complete',
    `
    <p>Account <b>${esc(email)}</b> was created and registered for YUILINK.</p>
    <p>A verification email has been sent. You can log in now, but YUILINK
       stays locked until the email is verified.</p>
    <div class="actions">
      <a class="btn" href="${esc(loginUrl(email, inviteToken))}">Login</a>
    </div>`,
  );
}

function errorListHtml(errors: string[]): string {
  return errors.length
    ? `<ul class="error">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '';
}

/** Sign up (option 2), step 1: email only. */
export function signup2EmailView(email = '', errors: string[] = []): string {
  return page(
    'Sign up (option 2)',
    `
    <p>YUILINK uses your <b>WebLiFE ID</b> — one account for all WebLiFE
       services. Enter your email to start.</p>
    ${errorListHtml(errors)}
    <form method="post" action="/auth/signup2/email" class="form">
      <label>Email <input name="email" type="email" required value="${esc(email)}"></label>
      <div class="actions">
        <button type="submit">Continue</button>
        <a class="btn secondary" href="/">Back</a>
      </div>
    </form>`,
  );
}

/**
 * Step 2, email already has a WebLiFE ID: no password field here — the user
 * proves they own the account by logging in on the FA page.
 */
export function signup2ExistingView(
  email: string,
  alreadyRegistered: boolean,
  forgotPasswordUrl: string,
): string {
  const message = alreadyRegistered
    ? `<p><b>${esc(email)}</b> already uses YUILINK. Log in with your WebLiFE ID
         password to continue.</p>`
    : `<p><b>${esc(email)}</b> already has a <b>WebLiFE ID</b> (the account you
         use for other WebLiFE services).</p>
       <p>Log in with its password to start using YUILINK — no new account or
         password is needed.</p>`;
  return page(
    'Sign up (option 2)',
    `
    ${message}
    <div class="actions">
      <form method="post" action="/auth/signup2/continue">
        <button type="submit">Log in with WebLiFE ID</button>
      </form>
      <a class="btn secondary" href="${esc(forgotPasswordUrl)}">Forgot password</a>
      <a class="btn secondary" href="/signup2">Use another email</a>
    </div>`,
  );
}

/** Step 2, new email: create the WebLiFE ID (+ YUILINK registration). */
export function signup2NewView(
  values: SignupValues,
  errors: string[] = [],
): string {
  return page(
    'Sign up (option 2)',
    `
    <p>Create a <b>WebLiFE ID</b> for <b>${esc(values.email)}</b>. You can use
       it for YUILINK and the other WebLiFE services.</p>
    ${errorListHtml(errors)}
    <form method="post" action="/auth/signup2" class="form">
      <input type="hidden" name="email" value="${esc(values.email)}">
      <label>Password <input name="password" type="password" required></label>
      <label>First name <input name="firstName" required value="${esc(values.firstName)}"></label>
      <label>Last name <input name="lastName" required value="${esc(values.lastName)}"></label>
      <div class="actions">
        <button type="submit">Sign up</button>
        <a class="btn secondary" href="/signup2">Use another email</a>
      </div>
    </form>`,
  );
}

function page(
  title: string,
  body: string,
  opts: { wide?: boolean; user?: JwtUser } = {},
): string {
  const account = opts.user
    ? `<div class="account">
        <span class="avatar">${esc(initial(opts.user.email))}</span>
        <span class="account-email">${esc(opts.user.email)}</span>
        <a class="btn ghost" href="/auth/fa-logout">Logout</a>
      </div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YUILINK demo — ${esc(title)}</title>
<style>
  :root {
    --bg: #f5f7fb; --surface: #fff; --border: #e3e8ef; --text: #1a2233; --muted: #6b7588;
    --primary: #4f46e5; --primary-hover: #4338ca; --primary-soft: #eef2ff;
    --danger: #dc2626; --ok: #059669; --ok-soft: #ecfdf5; --warn: #b45309; --warn-soft: #fffbeb;
    color-scheme: light;
    --radius: 12px; --shadow: 0 1px 2px rgba(16,24,40,.04), 0 4px 16px rgba(16,24,40,.06);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
  .topbar-inner { display: flex; align-items: center; gap: 16px; padding: 12px 16px; margin: 0 auto; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
  .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px;
                background: linear-gradient(135deg, #6366f1, #06b6d4); color: #fff; font-size: 14px; }
  .brand small { font-weight: 500; color: var(--muted); }
  .account { margin-left: auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
  .account-email { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  main { margin: 0 auto; padding: 28px 16px 48px; }
  .narrow { max-width: 560px; } .wide { max-width: 1040px; }
  h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 15px; margin: 0; }
  p { margin: 0 0 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
          box-shadow: var(--shadow); padding: 20px; }
  main.narrow > .card { padding: 24px; }
  .card-highlight { border-color: var(--primary); background: var(--primary-soft); margin-bottom: 16px; }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .card-head p { margin: 2px 0 0; }
  .count { background: var(--primary); color: #fff; border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
  .grid aside h2 { margin-bottom: 12px; }
  .stack { display: grid; gap: 16px; min-width: 0; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
  .card > :last-child { margin-bottom: 0; }
  .actions form { margin: 0; }
  .btn, button { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
                 padding: 8px 14px; border: 1px solid var(--primary); border-radius: 8px;
                 background: var(--primary); color: #fff; font: inherit; font-weight: 600;
                 text-decoration: none; cursor: pointer; transition: background .15s, border-color .15s; }
  .btn:hover, button:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
  .btn:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
    outline: 2px solid var(--primary); outline-offset: 2px; }
  button:disabled { opacity: .6; cursor: default; }
  .secondary { background: var(--surface); color: var(--primary); border-color: var(--border); }
  .secondary:hover { background: var(--primary-soft); border-color: var(--primary); }
  .ghost { background: transparent; color: var(--muted); border-color: transparent; padding: 6px 10px; }
  .ghost:hover { background: var(--primary-soft); color: var(--primary); border-color: transparent; }
  .form label { display: block; margin: 12px 0; font-weight: 600; font-size: 13px; }
  .form input, .form select { display: block; width: 100%; padding: 9px 11px; margin-top: 6px; font: inherit; font-weight: 400;
                border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }
  .error { color: var(--danger); font-size: 13px; }
  ul.error { background: color-mix(in srgb, var(--danger) 8%, transparent); border-radius: 8px; padding: 10px 10px 10px 28px; }
  pre { background: var(--bg); border: 1px solid var(--border); padding: 12px; border-radius: 8px;
        overflow-x: auto; font-size: 12px; margin: 12px 0 0; }
  pre:empty { display: none; }
  .muted { color: var(--muted); font-size: 13px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
       color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: middle; overflow-wrap: anywhere; }
  tr:last-child td { border-bottom: 0; }
  td.right { text-align: right; }
  td button { padding: 5px 12px; }
  .tag { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
         background: var(--bg); color: var(--muted); white-space: nowrap; overflow-wrap: normal; }
  .tag.owner { background: var(--primary-soft); color: var(--primary); }
  .tag.active { background: var(--ok-soft); color: var(--ok); }
  .tag.pending { background: var(--warn-soft); color: var(--warn); }
  .avatar { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 50%;
            background: linear-gradient(135deg, #6366f1, #06b6d4); color: #fff; font-weight: 700; flex: none; }
  .avatar.sm { width: 24px; height: 24px; font-size: 11px; margin-right: 8px; vertical-align: middle; }
  .ws { display: grid; gap: 4px; }
  .ws a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;
          color: var(--text); text-decoration: none; }
  .ws a:hover { background: var(--bg); }
  .ws a.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
  .ws-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; flex: none;
             background: var(--bg); border: 1px solid var(--border); font-weight: 700; font-size: 12px; }
  .ws a.active .ws-icon { background: var(--primary); border-color: var(--primary); color: #fff; }
  .ws-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dialog { border: 1px solid var(--border); border-radius: var(--radius); width: min(440px, calc(100vw - 32px));
           padding: 24px; background: var(--surface); color: var(--text); box-shadow: 0 20px 50px rgba(0,0,0,.25); }
  dialog::backdrop { background: rgba(15,20,32,.45); backdrop-filter: blur(2px); }
  dialog h2 { margin: 0 0 4px; font-size: 17px; }
  details summary { cursor: pointer; color: var(--muted); font-weight: 600; }
  details[open] summary { margin-bottom: 4px; }
  @media (max-width: 520px) {
    .account-email { display: none; }
    .card { padding: 16px; }
    th, td { padding: 8px 6px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner ${opts.wide ? 'wide' : 'narrow'}">
    <a class="brand" href="/"><span class="brand-mark">Y</span>YUILINK <small>demo</small></a>
    ${account}
  </div>
</header>
<main class="${opts.wide ? 'wide' : 'narrow'}">
  <h1>${esc(title)}</h1>
  ${opts.wide ? body : `<div class="card">${body}</div>`}
</main>
<script>
  function csrfToken() {
    const m = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function post(url) {
    const res = await fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken() } });
    const text = await res.text();
    document.getElementById('out').textContent = res.status + ' ' + text;
    return res;
  }
  async function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function errorMessage(res) {
    const body = await res.json().catch(() => ({}));
    return [].concat(body.message || res.statusText).join(', ');
  }
  function openInvite() {
    document.getElementById('invite-error').textContent = '';
    document.getElementById('invite-dialog').showModal();
  }
  function closeInvite() { document.getElementById('invite-dialog').close(); }
  async function submitInvite(e) {
    e.preventDefault();
    const form = e.target;
    const submit = form.querySelector('button[type=submit]');
    const error = document.getElementById('invite-error');
    error.textContent = '';
    submit.disabled = true;
    try {
      const res = await postJson('/workspaces/' + form.dataset.workspaceId + '/invite', {
        email: form.email.value,
        role: form.role.value,
      });
      if (res.ok) return location.reload();
      error.textContent = await errorMessage(res);
    } finally {
      submit.disabled = false;
    }
  }
  async function acceptInvite(workspaceId) {
    const res = await postJson('/invites/' + workspaceId + '/accept', {});
    if (res.ok) return (location.href = '/dashboard?workspaceId=' + workspaceId);
    document.getElementById('out').textContent = await errorMessage(res);
  }
  function resend() { post('/auth/resend-verification'); }
  async function refresh() {
    const res = await post('/auth/refresh');
    if (res.ok) location.reload();
  }
</script>
</body>
</html>`;
}
