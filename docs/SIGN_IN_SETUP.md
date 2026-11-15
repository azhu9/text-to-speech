# Setting up Google sign-in and sync

Sign-in is optional. Without it, the app works exactly as before and keeps
everything in your browser. With it, your library, the text of your documents
(including scanned pages), reading positions, highlights, notes, skip choices,
pronunciations, queue and voice settings sync between computers, and your
original PDFs are backed up.

It uses two free services:

- **Supabase**: login and storage for your data.
- **Google Cloud**: lets Supabase offer "Sign in with Google".

It takes about 15 minutes. You only do it once.

> Menu names on these sites change from time to time. If a label below doesn't
> match exactly, look for the closest equivalent.

---

## 1. Create a Supabase project

1. Go to <https://supabase.com>, sign up (you can use your Google account) and click **New project**.
2. Name it e.g. `read-aloud`, choose a database password (save it somewhere), pick the region closest to you, and create it. Wait a minute or two while it starts.

## 2. Create the database table

1. In your project, open **SQL Editor**, then **New query**.
2. Open the file [`supabase/schema.sql`](../supabase/schema.sql) from this repository, copy all of it, paste it into the editor, and click **Run**. You should see "Success. No rows returned".

This creates one private table for your synced data and a private file bucket
for your PDFs. Row-level security makes sure each account can only ever see its own rows.

## 3. Copy the project URL and key into the app

1. In Supabase, open **Project Settings**, then **API** (or **Data API** / **API Keys**).
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`) and the
   **anon / public** key (newer projects call it the **publishable** key; either works).
3. In the project folder, copy `.env.example` to `.env.local` and fill them in:

   ```
   VITE_SUPABASE_URL=https://abcdefgh.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
   ```

   `.env.local` is ignored by git. This key is meant to be public: it only allows
   what the security rules from step 2 allow.

## 4. Create Google login credentials

1. Go to <https://console.cloud.google.com> and create a project (top bar, then **New project**), e.g. `read-aloud`.
2. Open **Google Auth Platform** (in older layouts: **APIs & Services**, then **OAuth consent screen**) and click **Get started**:
   - App name: `Read Aloud`; user support email: your Gmail.
   - Audience: **External**.
   - Contact email: your Gmail. Agree and create.
3. Under **Audience**, then **Test users**, add your own Gmail address. Leaving the app in
   "Testing" mode is fine for personal use. Only test users can sign in.
4. Under **Clients** (or **Credentials**, then **Create credentials**, then **OAuth client ID**):
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: `http://localhost:5173`
   - **Authorized redirect URIs**: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (Supabase shows this exact "Callback URL" on its Google provider page in step 5).
   - Create, then copy the **Client ID** and **Client secret**.

## 5. Turn on Google in Supabase

1. In Supabase, open **Authentication**, then **Sign In / Providers** (or **Providers**), then **Google**.
2. Enable it, paste the Client ID and Client secret, and save.
3. Open **Authentication**, then **URL Configuration**:
   - **Site URL**: `http://localhost:5173`
   - **Redirect URLs**: add `http://localhost:5173/**`

## 6. Sign in

1. Restart the app (`npm run dev`) so it picks up `.env.local`.
2. In the library, click **Sign in with Google**. After signing in you'll see your
   name and "Synced just now". Everything already in this browser is uploaded the
   first time.
3. On another computer: clone the repo, add the same `.env.local`, run the app and sign in.
   Your library appears; PDFs download when they're needed (re-reading text or scanning pages).

## 7. Keep it to just you (recommended)

After your first sign-in, go to Supabase **Authentication**, then **Sign In / Providers**
(or **Settings**), and turn off **Allow new users to sign up**. With Google
in Testing mode, only your test users can sign in anyway.

---

## Good to know

- **Offline:** the app keeps working without internet and syncs when you're back online.
- **Conflicts:** if the same thing is changed on two computers before they sync, the
  most recent upload wins. A change that hasn't been uploaded yet is never overwritten.
- **Free plan limits:** 500 MB of database (text, notes) and 1 GB of file storage, with
  a 50 MB limit per file. PDFs larger than that stay on the computer they were added on
  (the library shows a note), and their text still syncs.
- **Inactivity:** free Supabase projects pause after about a week without use. If sync
  stops working, open the Supabase dashboard and click **Restore project**.
- **Deploying to a website later:** add that address to Google's JavaScript origins and to
  Supabase's Site URL / Redirect URLs.
