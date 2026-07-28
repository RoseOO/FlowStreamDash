import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = join(__dirname, '..', 'data', 'ecoflow.db');
export const DIST_DIR = join(__dirname, '..', 'dist');
export const DEFAULT_LAT = '52.5';
export const DEFAULT_LON = '-1.5';
export const PORT = process.env.PORT || 3000;
export const CO2_KG_PER_KWH = 0.233;
export const IDLE_TIMEOUT = 120;
export const POWER_FIELDS = [361, 70, 616];
export const GENERATION_THRESHOLD_W = 5;
export const API_RATE_LIMIT_MS = 1200;
