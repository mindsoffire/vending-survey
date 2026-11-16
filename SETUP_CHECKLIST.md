# Setup Checklist — Vending Survey

Complete these steps yourself to host the app and connect your own Google Drive. Never share passwords, keys, or secrets in chat.

## 1. Host the Static Files Over HTTPS (GitHub Pages)

- [ ] Unzip `vending-survey-pwa.zip`.
- [ ] Create a GitHub repository (e.g. `vending-survey`) and upload the contents of `vending-survey/` so `index.html` is at the repository root.
- [ ] Go to **Settings → Pages**, select **Deploy from a branch** (`main`, `/ (root)`), and save.
- [ ] Note your live HTTPS URL (for example: `https://your-username.github.io/vending-survey/`).

## 2. Create Your Google Cloud Project & OAuth Client ID

- [ ] Open [Google Cloud Console](https://console.cloud.google.com/) and create a new project (e.g. `Vending Survey`).
- [ ] Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
- [ ] Go to **Google Auth Platform → Branding** (or **APIs & Services → OAuth consent screen**):
  - Choose **External** user type.
  - Enter App name: `Vending Survey`, plus your support email and developer contact email.
  - Add scope: `https://www.googleapis.com/auth/drive.file`.
  - Under **Audience / Test users**, add your own Google account email. (While in Testing mode, Google will show an "unverified app" warning screen when you sign in—click **Continue** for your own test account. Wider public release later requires Google verification.)
- [ ] Go to **Google Auth Platform → Clients** (or **Credentials → Create Credentials → OAuth client ID**):
  - Application type: **Web application**.
  - **Authorised JavaScript origins**: add both:
    - `https://your-username.github.io` (your exact origin, without trailing slash or path)
    - `http://localhost:8080` (optional, for local testing)
  - Leave Authorised redirect URIs empty (Google Identity Services token client uses popup/in-page flow).
- [ ] Copy the generated **Client ID** (looks like `1234567890-abc123def456.apps.googleusercontent.com`).
- [ ] Put the Client ID in the app using either method:
  - **Option A (in code):** paste it into `googleOAuthClientId` in `config.js` before deploying.
  - **Option B (in app):** open **Settings → Google OAuth Client ID**, paste it, and tap **Save Client ID**.

## 3. Install on Your Oppo Find N3 (Android Chrome)

- [ ] Open your live `https://...` URL in **Chrome** on your Oppo Find N3.
- [ ] Tap the **Install** banner at the top of the Home screen (or Chrome menu **⋮ → Add to Home screen / Install app**).
- [ ] Launch **Vending Survey** from your home screen.

## 4. Grant Camera & Location Permissions

- [ ] On first **Start capture**, tap **While using the app** when Chrome asks for **Location** permission.
- [ ] Make sure phone **Location (GPS)** is switched on in Android Quick Settings (the app cannot toggle your phone's master location switch).
- [ ] On first **Take photo**, tap **While using the app** when Chrome asks for **Camera** permission.
- [ ] Go to **Settings → Sign in to Google** to link your Google Drive, then test capturing one machine and tapping **Done**.
