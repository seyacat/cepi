module.exports = {
  apps: [
    {
      name: 'cepi-backend',
      script: 'server.js',
      cwd: './backend',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
    {
      name: 'cepi-frontend',
      script: 'node_modules/vite/bin/vite.js',
      args: '--host',
      cwd: './frontend',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
