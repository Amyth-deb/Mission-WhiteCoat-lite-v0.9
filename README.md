# Mission WhiteCoat Lite v0.9

Temporary admin console for Mission WhiteCoat. Vanilla HTML/CSS/JS frontend, Supabase backend (auth + Postgres + Realtime). Deployable to GitHub + Vercel.

Members never log in. Only admins created in the database can access this site.

---

## 1. Tech Stack

- **Frontend:** HTML, CSS, vanilla JavaScript (no frameworks)
- **Backend:** Supabase (Postgres, Auth, Realtime, Row Level Security)
- **Hosting:** GitHub + Vercel

Files:
```
index.html      → App shell, login screen, all views, modals
style.css       → Premium dark glassmorphism theme
script.js       → All application logic (auth, CRUD, battle logic, realtime)
supabase.sql    → Full database schema, RLS policies, triggers
README.md       → This file
```

---

## 2. Create Your Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project.
2. Wait for provisioning to finish.
3. Go to **Project Settings → API** and copy:
   - `Project URL`
   - `anon public` API key

---

## 3. Run the Database Schema

1. Open **SQL Editor** in your Supabase project.
2. Paste the entire contents of `supabase.sql` and click **Run**.
3. This creates:
   - `admins`, `players`, `battle_days`, `battle_matches`, `battle_results` tables
   - UUID primary keys and timestamps on every table
   - Row Level Security policies (only authenticated admins can read/write)
   - A trigger that auto-creates an `admins` row whenever a new user is added in Supabase Auth
   - Realtime publication for the four synced tables

The script is idempotent — safe to re-run if needed.

---

## 4. Create Your First Admin

Members never sign up, and there is no public signup page. Admins are created directly in Supabase:

1. Go to **Authentication → Users** in the Supabase Dashboard.
2. Click **Add user** → **Create new user**.
3. Enter the admin's email and a password. (You can also use "Invite by email" if you've configured an email provider.)
4. Click **Create user**.

That's it — the database trigger automatically creates a matching row in `public.admins`, and that person can now log in to the app immediately. Repeat for every admin / the Super Admin.

To promote someone to Super Admin, run in the SQL Editor:
```sql
update public.admins set role = 'super_admin' where email = 'someone@example.com';
```
(The Lite version doesn't have a separate super-admin-only screen yet — that's reserved for Mission WhiteCoat X — but the `role` column is already in place for that future work.)

---

## 5. Configure the Frontend

Open `script.js` and edit the two constants near the top:

```js
const SUPABASE_URL = "YOUR_SUPABASE_PROJECT_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
```

Paste in the values you copied in Step 2. **Only ever use the `anon` key here** — never the `service_role` key, which must never appear in frontend code.

---

## 6. Run Locally

No build step is required. Any static file server works, for example:

```bash
npx serve .
```

or open `index.html` directly with a "Live Server" style extension. Then log in with the admin credentials you created in Step 4.

---

## 7. Deploy to GitHub + Vercel

1. Create a new GitHub repository and push these 5 files to it:
   ```bash
   git init
   git add .
   git commit -m "Mission WhiteCoat Lite v0.9"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → import the GitHub repo.
3. Framework preset: **Other** (static site). No build command, no output directory override needed — Vercel will serve the files as-is.
4. Click **Deploy**.
5. Once live, share the Vercel URL with your admins.

---

## 8. How the App Works

### Dashboard
Shows today's date, total players, today's participant count, and the current workflow status (`Not Generated` → `Battles Generated` → `Results Published`).

### Player Manager
Add, edit, delete, search, import (bulk paste, one name per line — duplicates and blank lines are ignored automatically), export (CSV), and undo the most recent delete. Every admin, on every device, sees the same synced list.

### Today's Participants
Checkbox list of all players. Select All / Clear Selection. Selections are stored per calendar date in `battle_days.participant_ids` and sync across all admins.

### Battle Generator
Click **Generate Battles** to randomly shuffle today's participants:
- Even count → all 1v1 battles.
- Odd count → every battle is 1v1 except the last, which is 1v1v1. No one sits out.

Manual editing per battle:
- **Lock** a battle so it's untouched by future regenerations.
- **Regenerate** a single battle (swaps its players with another unlocked battle for a fresh matchup).
- **Delete** a battle (its players become "Unassigned" and can be manually reassigned with **Assign**, or picked up automatically next time you click Regenerate All).
- **⇄ Swap** a specific player with any other unlocked player.
- **↪ Move** a specific player into a different existing battle.
- **Regenerate All** reshuffles every unlocked battle at once; locked battles are untouched.

### Study Hours & Results
Enter each player's study hours. The winner/loser/draw is computed automatically:
- 2-player battle: higher hours wins; equal hours = draw for both.
- 3-player battle: highest hours wins; if the top hours are tied, those tied players draw and the remaining player loses.

Click **Publish Results** to permanently snapshot the day into History.

### History
Every published day, forever. **View Details** shows every battle, hours, and winner exactly as it was at publish time (even if players or matches are later edited or deleted). **Delete History** removes just that history entry.

### Copy Buttons
- **Copy Today's Battles** → formatted with ⚔ header and 🆚 between names.
- **Copy Results** → formatted with 🏆 header, hours, and ✅ Winner / 🤝 Draw tags.

### Realtime Sync
The app subscribes to Supabase Realtime on `players`, `battle_days`, `battle_matches`, and `battle_results`. When any admin makes a change, every other connected admin sees it appear automatically. A 30-second background refresh also runs at all times as a safety net in case a realtime connection drops.

### Security
- Row Level Security is enabled on every table.
- Only authenticated admins (rows that exist in `public.admins`) can read or write any data.
- Anonymous visitors have zero access to any table.
- Only the Supabase `anon` key is ever used in frontend code — the `service_role` key is never exposed.

---

## 9. Troubleshooting

- **"This account is not registered as an admin."** → The Supabase Auth user exists but has no matching row in `public.admins`. Re-run the trigger setup in `supabase.sql`, or manually insert a row: `insert into public.admins (id, email) values ('<auth-user-uuid>', 'email@example.com');`
- **Realtime dot stays gray/orange instead of green** → Realtime may be disabled for your tables. In Supabase Dashboard → Database → Replication, confirm `players`, `battle_days`, `battle_matches`, `battle_results` are toggled on for the `supabase_realtime` publication (the SQL script does this automatically, but double-check after project creation).
- **Import skips a name I expected to be added** → Names are matched case-insensitively and trimmed of whitespace, so "Amit" and "amit " are treated as duplicates by design.
