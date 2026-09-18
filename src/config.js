import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3000,
  baseUrl: process.env.BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`,
  dataDir: process.env.DATA_DIR || './data',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',

  // 钉钉企业内部应用（内部员工免登）
  dingtalkAppKey: process.env.DINGTALK_APPKEY || '',
  dingtalkAppSecret: process.env.DINGTALK_APPSECRET || '',

  // 外部参与者（院校学生）短信：原型期用开发验证码
  devSmsCode: process.env.DEV_SMS_CODE || '123456',

  // GitHub 同步（可选，与现有 workbuddy001 一致）
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
};
