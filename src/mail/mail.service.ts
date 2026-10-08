import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { esc } from '../views';

/** Same SMTP setup as apps/backend MailModule (SendGrid, `EMAIL_*` env). */
@Injectable()
export class MailService {
  private transporter?: nodemailer.Transporter;

  private get transport(): nodemailer.Transporter {
    if (!this.transporter) {
      const host = process.env.EMAIL_HOST;
      if (!host) throw new InternalServerErrorException('EMAIL_HOST not set');
      const user = process.env.EMAIL_USER;
      const pass = process.env.EMAIL_PASSWORD;
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.EMAIL_PORT) || 587,
        secure: false,
        ...(user && pass ? { auth: { user, pass } } : {}),
      });
    }
    return this.transporter;
  }

  async sendWorkspaceInvite(p: {
    to: string;
    inviterName: string;
    workspaceName: string;
    role: string;
    acceptUrl: string;
  }): Promise<void> {
    await this.transport.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@bindup.jp',
      to: p.to,
      subject: `【YUILINK】「${p.workspaceName}」ワークスペースへの招待`,
      html: `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head><body><div style="white-space: pre-line;">--------------------------------------------
このメールはYUILINKから自動配信されています。
--------------------------------------------

${esc(p.inviterName)} さんから「${esc(p.workspaceName)}」ワークスペースに招待されました。

役割: ${esc(p.role)}

以下のリンクから招待を承認してください。
アカウントをお持ちでない場合も、リンク先から新規登録できます。
<a href="${esc(p.acceptUrl)}">招待を承認する</a>

このリンクの有効期限は7日間です。

--------------------------------------------
YUILINK</div></body></html>`,
    });
  }
}
