// PM2 process manager config. Run from the repo root on the VPS:
//   pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "twittence",
      cwd: __dirname + "/../functions",
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "300M",
      restart_delay: 3000,
      max_restarts: 10,
      out_file: "../logs/out.log",
      error_file: "../logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
