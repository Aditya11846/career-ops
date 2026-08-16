/**
 * PM2 ecosystem — Branch 1A autonomy layer B.
 *
 * Two one-shot jobs, each restarted by PM2 on its own cron (autorestart:false
 * means a crash never loops — cron fires the next scheduled run regardless):
 *
 *   career-ops-scan       every 6h  (:05)  scan.mjs → scan-and-process.mjs
 *                                          (watchlist fire-hose + top-N evals)
 *   career-ops-discovery  every 12h (:17)  scan-ats-full.mjs reverse-ATS
 *                                          discovery + VC-portfolio seed auto-sourcing
 *
 * Install / manage:
 *   pm2 start scripts/pm2/ecosystem.config.cjs
 *   pm2 status            # or `pm2 list` — see the two apps
 *   pm2 restart career-ops-scan          # run a scan+process cycle now
 *   pm2 logs career-ops-scan             # follow the run log
 *   pm2 delete career-ops-scan           # remove a job
 *   pm2 save                             # persist the process list
 *   pm2 startup                           # (run once) daemonize across reboots
 *
 * Logs: each run appends to .claude/notes/cron-logs/ (see the run scripts).
 * The web dashboard's status route surfaces these apps (web/src/app/api/status).
 */

module.exports = {
  apps: [
    {
      name: "career-ops-scan",
      script: "scripts/pm2/scan-and-process-run.mjs",
      cwd: __dirname + "/../..",
      // Every 6h on the :05 mark — off the :00/:30 herd beats so a fleet-wide
      // scheduler surge never collides with the API tier.
      cron_restart: "5 */6 * * *",
      autorestart: false,
      max_restarts: 1,
      env: {
        SCAN_PROCESS_TOP_N: "20",
      },
    },
    {
      name: "career-ops-discovery",
      script: "scripts/pm2/discovery-run.mjs",
      cwd: __dirname + "/../..",
      cron_restart: "17 */12 * * *",
      autorestart: false,
      max_restarts: 1,
      env: {
        DISCOVERY_SEEDS: "yc,a16z,sequoia,accel",
        DISCOVERY_SINCE_DAYS: "14",
        DISCOVERY_LIMIT: "150",
      },
    },
  ],
};
