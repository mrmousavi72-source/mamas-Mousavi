const path = require('node:path');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', 'data.sqlite');
const allowSimulation = process.env.ALLOW_SIMULATION === 'true';
const tilesPath = process.env.MAP_TILES_PATH ?? path.join(__dirname, '..', 'data', 'iran.pmtiles');

const app = createApp(openDatabase(dbPath), { allowSimulation, tilesPath });
app.listen(port, () => {
  console.log(`بدو روی http://localhost:${port} اجرا شد (حالت آزمایشی: ${allowSimulation ? 'فعال' : 'غیرفعال'})`);
});
