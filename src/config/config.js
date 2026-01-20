import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

export default {
  // Параметры портала
  portal: {
    baseUrl: process.env.PORTAL_BASE_URL || 'https://v3bl.goszakup.gov.kz',
    timeout: parseInt(process.env.PORTAL_TIMEOUT || '30000', 10),
  },

  // Настройки ncanode
  ncanode: {
    url: process.env.NCANODE_URL || 'http://localhost:14579',
    // Порт для nclayer (обычно 14579)
    port: parseInt(process.env.NCANODE_PORT || '14579', 10),
  },

  // Настройки авторизации
  auth: {
    ssoUrl: process.env.SSO_URL || 'https://v3bl.goszakup.gov.kz/sso',
    username: process.env.AUTH_USERNAME || '',
    password: process.env.AUTH_PASSWORD || 'holbol21***',
    // Путь к сертификату ЭЦП
    certPath: process.env.CERT_PATH || '',
    certPassword: process.env.CERT_PASSWORD || 'B5380532b',
  },

  // Настройки HTTP клиента
  http: {
    userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeout: parseInt(process.env.HTTP_TIMEOUT || '30000', 10),
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '3', 10),
    retryDelay: parseInt(process.env.RETRY_DELAY || '1000', 10),
  },

  // Настройки cron
  cron: {
    enabled: process.env.CRON_ENABLED === true,
    schedule: process.env.CRON_SCHEDULE || '0 9 * * *', // Каждый день в 9:00
  },

  // Логирование
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/app.log',
  },
  legalAddress:{
    789512:'КАЗАХСТАН, 231010000, Атырауская область, г.Атырау, Азаттык, 130а',
    678158:'КАЗАХСТАН, 231010000, none, Атырауская область, г.Атырау, АЗАТТЫК, 130А, 19',
    207309:'Казахстан, 631010000, 070000, Восточно-Казахстанская область, г.Усть-Каменогорск, Беспалова, 45/3, 64',
  }
};



















