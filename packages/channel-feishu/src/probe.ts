/**
 * P0-03 飞书长连接探测：`node packages/channel-feishu/dist/probe.js [--minutes 5] [--reply] [--bounce]`
 *
 * 凭据从 Windows 凭据管理器的 `paldock/feishu` 读取（user = App ID，密码 = App Secret）。
 * 收到的 im.message.receive_v1 先写入 inbox（以平台 event_id 去重），再按需在单聊里回复一句固定文字。
 * `--bounce` 在运行中途主动断开再重连，验证重连与断线期间的事件。
 * 输出只含事件类型、会话类型、去重结果与延迟，不含消息正文、用户 ID 与凭据。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { readCredential } from '@paldock/platform';
import { openStore } from '@paldock/storage-sqlite';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const minutes = Number(args[args.indexOf('--minutes') + 1]) || 5;
const log = (line: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), line, ...extra }));

interface MessageEvent {
  event_id?: string;
  create_time?: string;
  message: { message_id: string; chat_id: string; chat_type: string; message_type: string };
}

async function main(): Promise<void> {
  const credential = await readCredential('paldock/feishu');
  if (!credential) return log('凭据管理器中没有 paldock/feishu');

  const dataRoot = mkdtempSync(join(tmpdir(), 'paldock-feishu-probe-'));
  const store = await openStore(dataRoot);
  const base = { appId: credential.user, appSecret: credential.secret, loggerLevel: Lark.LoggerLevel.warn };
  const client = new Lark.Client(base);
  let received = 0;

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: MessageEvent) => {
      const eventId = data.event_id ?? `missing:${data.message.message_id}`;
      const fresh = store.inbox.accept('feishu', eventId, data.message.chat_id, '{}');
      const latencyMs = data.create_time ? Date.now() - Number(data.create_time) : undefined;
      log('message', {
        fresh,
        hasEventId: data.event_id !== undefined,
        chatType: data.message.chat_type,
        messageType: data.message.message_type,
        latencyMs,
        payloadKeys: Object.keys(data).sort(),
      });
      if (!fresh) return;
      received++;
      if (flag('--reply') && data.message.chat_type === 'p2p') {
        const sent = await client.im.v1.message
          .reply({
            path: { message_id: data.message.message_id },
            data: { msg_type: 'text', content: JSON.stringify({ text: `PalDock P0 探测已收到第 ${received} 条消息` }) },
          })
          .then(
            (r) => ({ ok: r.code === 0, code: r.code }),
            (e: Error) => ({ ok: false, error: e.name }),
          );
        log('reply', sent);
      }
    },
  });

  const connect = () =>
    new Lark.WSClient({
      ...base,
      onReady: () => log('ws ready'),
      onError: (e) => log('ws error', { name: e.name }),
      onReconnecting: () => log('ws reconnecting'),
      onReconnected: () => log('ws reconnected'),
    });
  let ws = connect();
  await ws.start({ eventDispatcher: dispatcher });
  log('listening', { minutes });

  if (flag('--bounce')) {
    setTimeout(async () => {
      log('bounce: closing');
      ws.close();
      await new Promise((r) => setTimeout(r, 15_000));
      ws = connect();
      await ws.start({ eventDispatcher: dispatcher });
      log('bounce: restarted');
    }, (minutes * 60_000) / 2);
  }

  await new Promise((r) => setTimeout(r, minutes * 60_000));
  ws.close();
  log('done', { received, inboxRows: store.db.get<{ n: number }>('SELECT count(*) AS n FROM inbox')?.n });
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
  process.exit(0);
}

main().catch((error: Error) => {
  log('failed', { name: error.name, message: error.message.slice(0, 200) });
  process.exit(1);
});
