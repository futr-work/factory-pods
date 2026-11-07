# Self-Hosting Guide

Factory Pods are 100% open source. You can self-host any reference pod or custom pod on your own Cloudflare account or Node.js server with zero software licensing fees.

---

## 1. Quick Deploy to Cloudflare Workers (Recommended)

### Prerequisites
- Node.js 20+
- Free or Paid [Cloudflare Account](https://dash.cloudflare.com)
- Cloudflare Wrangler CLI (`npm install -g wrangler`)

### Step-by-Step

1. **Clone the monorepo**:
   ```bash
   git clone https://github.com/futr-work/factory-pods.git
   cd factory-pods
   npm install
   ```

2. **Choose a pod** (e.g. `pods/starter` or `pods/model-governor`):
   ```bash
   cd pods/starter
   ```

3. **Create your D1 database**:
   ```bash
   npx wrangler d1 create factory-pod-db
   ```
   Copy the `database_id` output by Wrangler into your `wrangler.jsonc` file.

4. **Apply initial SQLite schema**:
   ```bash
   npx wrangler d1 execute factory-pod-db --local --file=schema.sql
   npx wrangler d1 execute factory-pod-db --remote --file=schema.sql
   ```

5. **Deploy globally**:
   ```bash
   npx wrangler deploy
   ```

Your pod is now live on your `*.workers.dev` domain.

---

## 2. Local Development & Cockpit

Every pod includes a dark-mode web cockpit and real-time execution logs.

```bash
cd pods/starter
npm run dev
```

Open `http://localhost:8787` in your browser. You will see the local cockpit, current health metrics, and active task status.

---

## 3. Managed fleets

If you would rather not run Cloudflare D1 migrations, bindings and alerting yourself, [futr.work](https://futr.work) builds and operates pod fleets.

---

## 4. Sovereign Cloud & Ubicloud Deployment

For users who do not want to use Cloudflare or require strict European data residency / hardware sovereignty:
- **Ubicloud Support**: Run Factory Pod fleets on [Ubicloud](https://www.ubicloud.com/) open-source Linux VMs with Managed PostgreSQL on Hetzner bare metal.
- **Docker / Self-Hosted `workerd`**: Run the open-source Cloudflare `workerd` engine or standard Node.js/Bun containers on your own infrastructure.


