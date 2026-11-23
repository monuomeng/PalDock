import { fileURLToPath } from 'node:url';

/** 离线模拟 app-server 的入口（src/ 与 dist/ 下都按包根定位），供测试和桌面端到端检查使用。 */
export const MOCK_APP_SERVER_PATH = fileURLToPath(new URL('../mock/mock-app-server.mjs', import.meta.url));
