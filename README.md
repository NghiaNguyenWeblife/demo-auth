# yuilink-demo

App NestJS tối giản để demo đăng nhập FusionAuth bằng client **[LOCAL] YUILINK APP**
(tenant **[DEV] WEBLIFE-DIRECT**). Logic auth port từ `apps/backend/src/auth`, bỏ phần
DB và webhook, thêm bước bắt buộc đăng ký YUILINK.

Không thuộc yarn workspace của repo (có `yarn.lock` riêng).

## Chạy

```bash
cd yuilink-demo
cp .env.sample .env   # điền FUSIONAUTH_CLIENT_SECRET, FUSIONAUTH_API_KEY
yarn install
yarn dev              # http://localhost:4200
```

- `FUSIONAUTH_CLIENT_SECRET`: FA admin → Applications → [LOCAL] YUILINK APP → OAuth → Client secret
- `FUSIONAUTH_API_KEY`: giống `apps/backend/.env`
- `EMAIL_*` (mail mời, SendGrid SMTP): giống `apps/backend/.env`. `EMAIL_FROM` phải là sender đã verify trên SendGrid
- `APP_URL`: base URL của app, dùng cho link trong mail mời

## Setting FA của YUILINK

| Setting | Giá trị | Lý do |
|---|---|---|
| OAuth → Authorized redirect URLs | `http://localhost:4200/auth/fusionauth/callback` | |
| OAuth → Require registration | OFF | Nếu ON thì user chưa đăng ký không vào được bước "Register" của app |
| Registration → Verify registrations | OFF | Tránh mail xác minh registration thừa; app chỉ kiểm tra xác minh email |
| OAuth → Logout URL | `http://localhost:4200/` | Logout / "Log in with another account" quay về app |
| `data.returnURL` (set qua API) | `http://localhost:4200/auth/refresh-redirect` | Nút quay về app ở trang "đã xác minh email" của theme (xem dưới) |
| Registration → Self-service registration | **Enabled** (basic) | Cần cho trang đăng ký của FA (`/oauth2/register`) |

Self-service bật thì FA **tự tạo** registration cho user cũ ngay khi login (kể cả khi
Require registration OFF). Vì vậy registration trên FA chưa đủ: app chỉ coi là user YUILINK
khi registration có cờ `data.yuilinkConfirmed = true` do app ghi (`FUSIONAUTH_API_KEY`).

## Luồng đăng ký / đăng nhập

- **Login** → FA login → callback. App kiểm tra registration YUILINK
  (`GET /api/user/registration/{userId}/{appId}`):
  - có cờ `yuilinkConfirmed` → cấp session (cookie).
  - có nhưng chưa có cờ (do FA tự tạo):
    - user và registration tạo cùng lúc (lệch ≤ 10 giây) = vừa đăng ký ở trang FA → app ghi
      cờ, tạo workspace, cấp session.
    - user có từ trước = FA tự đăng ký lúc login → app **xoá registration**, xử lý như "không có".
  - không có → **không cấp session**, token giữ tạm server-side 10 phút, hiện trang
    "Register for YUILINK":
    - **Register** → app tạo registration có cờ (`POST /api/user/registration/{userId}`) → vào app.
    - **Cancel** → bỏ token tạm + FA logout.
- **Sign up (user mới)** → `/signup` → trang đăng ký của FA (`/oauth2/register`). Đăng ký xong
  FA quay về callback như Login → vào thẳng app (trang "Verify your email"). FA gửi mail xác
  minh email (setting Verify email của tenant).
- **Sign up (option 2)** — nhập email trước (`/signup2`), server tra email trong tenant
  (`GET /api/user?email=`):
  - chưa có → form mật khẩu + họ tên → tạo user + registration YUILINK (như Sign up cũ).
  - đã có WebLiFE ID → báo "đã có WebLiFE ID", **không** có ô mật khẩu/họ tên. Nút
    "Log in with WebLiFE ID" → FA login (email điền sẵn) → callback **tự tạo
    registration YUILINK**, không qua trang "Register for YUILINK". Có nút Forgot
    password (trang FA).
  - Chỉ tự đăng ký khi email đăng nhập **trùng** email đã nhập ở bước 1 (FA SSO có thể
    đăng nhập ngầm bằng tài khoản khác → rơi về trang "Register for YUILINK").
  - Bước 1 cho biết email đã có tài khoản hay chưa (dò được tài khoản). Không có rate limit.
- Đăng nhập xong → `/dashboard` (`FUSIONAUTH_POST_LOGIN_REDIRECT`).
- Registration bị xoá sau khi đăng nhập → request tiếp theo / refresh bị từ chối.
- Email chưa xác minh → vẫn đăng nhập nhưng bị khoá ở trang "Verify your email".

## Workspace & mời member

Data lưu ở file JSON trong `data/` (ghi qua 1 queue trong process, không an toàn khi chạy nhiều instance):

- `workspaces.json`: `{ workspaceId: <timestamp>, name: <tên ngẫu nhiên> }`
- `member_roles.json`: `{ workspaceId, userId: <FA id, null khi chưa accept>, email, role: owner|member, status: pending|active, inviteToken, inviteExpiresAt }`

**Đăng ký YUILINK** (trang FA, `/auth/signup2`, `/auth/yuilink-register`) → tạo 1 workspace + record `owner`.
Nếu email đang có lời mời `pending` thì **không** tạo workspace (user sẽ vào workspace được mời).

**Mời** (chỉ owner): Dashboard → Invite → email + role → record `pending` (token hạn 7 ngày) + gửi mail
`APP_URL/invite/accept?token=…`. Mời lại email đang pending → token mới, gửi lại mail.

**Accept** — luôn cần `email_verified` và email trong id_token **khớp** email được mời. Không dùng
cookie: lời mời của user được xác định bằng email đã xác minh trong `member_roles`.

- Link trong mail `/invite/accept?token=…`:
  - đăng nhập đúng email → `active` → dashboard của workspace đó
  - đăng nhập sai email → trang "Wrong account" (logout rồi login lại)
  - email chưa xác minh → trang "Verify your email"
  - chưa đăng nhập → trang lời mời: Login (điền sẵn email bằng `login_hint`, login xong quay lại
    link) / Sign up (`/signup?invite=…` → trang đăng ký FA, đăng ký xong quay lại link)
- Dashboard có mục **"Pending invitations"** (lời mời gửi tới email đã xác minh của user) → user tự
  bấm Accept. Dùng khi không còn link (sau khi xác minh email, đổi tài khoản, mở ở trình duyệt khác).
  Đăng nhập **không** tự accept.

## Endpoint

| Method | Path | |
|---|---|---|
| GET  | `/` | chưa đăng nhập (Login / Sign up) hoặc chờ đăng ký YUILINK. Có session → `/dashboard` |
| GET  | `/dashboard` | chưa xác minh email / dashboard (workspace, member, lời mời). `?workspaceId=` chọn workspace. Không có session → `/` |
| GET  | `/signup` | → `/auth/fusionauth/register` (`?invite=` quay lại link lời mời sau khi đăng ký) |
| GET  | `/auth/fusionauth/register` | → trang đăng ký của FA (code + PKCE) |
| GET  | `/signup2` | Sign up (option 2), bước 1: nhập email |
| POST | `/auth/signup2/email` | tra email → bước 2 (form mới / "đã có WebLiFE ID") |
| POST | `/auth/signup2/continue` | email đã có: → FA login, tự đăng ký YUILINK sau callback |
| POST | `/auth/signup2` | email mới: tạo user + registration YUILINK |
| GET  | `/auth/fusionauth/login` | → FA login (code + PKCE) |
| GET  | `/auth/fusionauth/callback` | đổi code lấy token, kiểm tra registration |
| POST | `/auth/yuilink-register` | user cũ: tạo registration YUILINK rồi cấp session |
| GET  | `/auth/pending-cancel` | huỷ đăng ký YUILINK + FA logout |
| POST | `/auth/refresh` | refresh token |
| GET  | `/auth/refresh-redirect` | refresh ngầm, thất bại thì → FA login |
| POST | `/auth/logout` | revoke + xoá cookie, trả `logoutUrl` |
| GET  | `/auth/fa-logout` | revoke + xoá cookie + redirect FA logout |
| GET  | `/auth/me` | thông tin user (cần đăng nhập) |
| POST | `/auth/resend-verification` | gửi lại email xác minh (cần đăng nhập + CSRF) |
| GET  | `/invite/accept` | `?token=`: trang lời mời / accept |
| POST | `/workspaces/:id/invite` | owner mời `{ email, role }` (cần đăng nhập + CSRF) |
| POST | `/invites/:workspaceId/accept` | accept lời mời từ dashboard (cần đăng nhập + CSRF) |

Cookie giống backend: `access_token`, `csrf_token`, `refresh_token` (path `/auth`),
thêm `yl_pending_registration` cho trạng thái chờ đăng ký.
Cookie localhost dùng chung giữa các port, nên đăng nhập ở đây sẽ đè session của
backend (port 4000) và ngược lại.

## Kịch bản demo

1. **User đã có trong tenant, chưa đăng ký YUILINK** → Login → trang "Register for
   YUILINK" (chưa vào được) → Register → vào được, dùng mật khẩu cũ.
2. **User mới** → Sign up → đăng ký trên trang FA → trang "Verify your email" (chưa vào được) → bấm
   link trong mail → **I have verified** → vào được.
3. User ở (2) đăng nhập [DEV] CONTROLPANEL / [DEV] DSMYPAGE bằng cùng mật khẩu.
4. **Sign up (option 2), email đã có WebLiFE ID** → nhập email → "đã có WebLiFE ID" →
   Log in with WebLiFE ID → nhập mật khẩu cũ trên FA → vào thẳng dashboard.
5. **Sign up (option 2), email mới** → nhập email → form mật khẩu + họ tên → giống (2).

## Giới hạn

- FA không chặn user chưa đăng ký — việc chặn nằm ở app. App khác dùng client
  YUILINK mà không có bước kiểm tra này sẽ cho vào.
- Mỗi lần load `/` / `/dashboard`, gọi API có guard, và refresh đều gọi FA API kiểm tra registration.
- Mật khẩu của user mới ở Sign up (option 2) đi qua server app (form riêng thay cho trang FA).
- Trang login của FA có link "Create an account", trang đăng ký có link về login: user cũ đi
  cửa nào cũng bị callback xoá registration FA tự tạo và đưa về trang "Register for YUILINK".
- Registration tạo trước khi có cờ `yuilinkConfirmed` phải được ghi cờ thủ công, nếu không lần
  login tới app coi như vừa đăng ký và tạo thêm 1 workspace.
- Token chờ đăng ký, PKCE state, revocation đều in-memory, mất khi restart. Đặt
  `VALKEY_HOST` trỏ tới Valkey của controlpanel để dùng chung trạng thái logout.
- Không có webhook: FA không báo cho app khi user bị xoá / deactivate / đổi mật khẩu.
- Trang "đã xác minh email" của FA (theme `emailComplete`) không tự redirect; app nhận biết qua
  `client_id` trong link mail. Mail gửi lại từ app có `applicationId` nên có `client_id` của YUILINK.
  `refresh-redirect` không nhận được `refresh_token` (cookie `SameSite=Strict`, bị chặn khi đến
  từ trang FA) nên sẽ đi qua FA login — có SSO session thì tự đăng nhập lại, token mới có
  `email_verified=true`.
- User đã đăng ký YUILINK trước khi có tính năng workspace sẽ không có workspace.
- Mời email chưa có tài khoản FA: user tự Sign up từ trang lời mời (email điền sẵn).
