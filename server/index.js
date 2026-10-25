const path = require('node:path');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', 'data.sqlite');
const allowSimulation = process.env.ALLOW_SIMULATION === 'true';

const app = createApp(openDatabase(dbPath), { allowSimulation });
app.listen(port, () => {
  console.log(`قلمرو روی http://localhost:${port} اجرا شد (حالت آزمایشی: ${allowSimulation ? 'فعال' : 'غیرفعال'})`);
});
