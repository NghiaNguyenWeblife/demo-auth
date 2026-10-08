/** Link in the invite mail. Also used as the post-login redirect back to it. */
export function inviteAcceptUrl(token: string): string {
  const appUrl = (process.env.APP_URL || 'http://localhost:4200').replace(
    /\/$/,
    '',
  );
  return `${appUrl}/invite/accept?token=${encodeURIComponent(token)}`;
}
