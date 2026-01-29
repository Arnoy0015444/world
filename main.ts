/**
 * HIGH PERFORMANCE VLESS WORKER
 * Optimized for Speed and Low Latency
 * Protocol: VLESS + WebSocket + TLS
 */

import { connect } from 'cloudflare:sockets';

// تنظیمات اصلی - حتما یک UUID جدید تولید کنید و اینجا قرار دهید
const UUID = '25700739-775c-435e-92a0-e2652fca6621'; 

// اگر می‌خواهید ترافیک از پروکسی‌های خاصی عبور کند (برای دور زدن فیلترینگ شدیدتر)
// می‌توانید آدرس IP یا دامین تمیز کلودفلر را اینجا بگذارید. در غیر این صورت خالی بگذارید.
const PROXY_IP = ''; 

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');

      // 1. نمایش پنل کاربری و لینک سابسکرایب در مرورگر
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        const expectedPath = `/${UUID}`;
        if (url.pathname === expectedPath || url.pathname === '/') {
           return new Response(renderHTML(request, url.hostname), {
            status: 200,
            headers: { 'Content-Type': 'text/html;charset=utf-8' },
          });
        }
        return new Response('FoxCloud VLESS Worker is Running.', { status: 200 });
      }

      // 2. پردازش اتصال VLESS (WebSocket)
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      
      // پردازش اولیه هدر VLESS
      let vlessHeader = null;
      
      server.addEventListener('message', async (event) => {
        if (!vlessHeader) {
          try {
            vlessHeader = parseVlessHeader(event.data);
            if (vlessHeader.uuid !== UUID.replace(/-/g, '')) {
              server.close(); 
              return;
            }
            // اتصال به مقصد نهایی
            await handleTCP(server, vlessHeader, event.data);
          } catch (err) {
            console.error('VLESS Header Error:', err);
            server.close();
          }
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });

    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  },
};

// --- توابع پردازش شبکه (هسته اصلی) ---

async function handleTCP(serverWebSocket, vlessRequest, firstChunk) {
  const address = vlessRequest.addressType === 1 ? vlessRequest.address : vlessRequest.domain;
  const port = vlessRequest.port;

  // حذف هدر VLESS از اولین بسته دیتا برای ارسال به سرور مقصد
  const rawClientData = firstChunk.slice(vlessRequest.headerLength);

  try {
    // اتصال سریع با استفاده از Cloudflare Sockets
    const socket = connect({
      hostname: address,
      port: port,
    });

    const writer = socket.writable.getWriter();

    // استریم کردن دیتا از سوکت مقصد به کلاینت (کاربر)
    // اینجا پاسخ اولیه VLESS (نسخه و ...) را هم اضافه می‌کنیم
    const responseHeader = new Uint8Array([vlessRequest.version, 0]);
    serverWebSocket.send(responseHeader);

    // پایپ کردن سوکت به وب‌ساکت (Downstream)
    socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        serverWebSocket.send(chunk);
      },
      close() {
        serverWebSocket.close();
      },
      abort(err) {
        console.error('Socket Read Error:', err);
        serverWebSocket.close();
      }
    }));

    // ارسال دیتای اولیه (که همراه هدر آمده بود) به مقصد
    if (rawClientData.byteLength > 0) {
      await writer.write(rawClientData);
    }

    // استریم کردن دیتا از کلاینت (وب‌ساکت) به سوکت مقصد (Upstream)
    serverWebSocket.addEventListener('message', async (msg) => {
      try {
          // اگر پیام متنی بود نادیده بگیر (VLESS باینری است)
          if (typeof msg.data === 'string') return;
          await writer.write(msg.data);
      } catch (e) {
          // سوکت بسته شده است
      }
    });
    
    // مدیریت بسته شدن
    serverWebSocket.addEventListener('close', () => {
        try { writer.close(); } catch(e){}
    });

  } catch (error) {
    console.error('Connect Error:', error);
    serverWebSocket.close();
  }
}

// --- توابع کمکی VLESS ---

function parseVlessHeader(buffer) {
  if (buffer.byteLength < 24) throw new Error('Invalid Data');
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  
  // خواندن UUID (16 بایت)
  const uuidBytes = new Uint8Array(buffer.slice(1, 17));
  const uuid = [...uuidBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength); // 1=TCP, 2=UDP
  
  const portIndex = 18 + optLength + 1;
  const port = view.getUint16(portIndex);
  
  const addressType = view.getUint8(portIndex + 2);
  let address = '';
  let domain = '';
  let addressLength = 0;
  let headerLength = 0;

  const addressStartIndex = portIndex + 3;

  if (addressType === 1) { // IPv4
    addressLength = 4;
    address = new Uint8Array(buffer.slice(addressStartIndex, addressStartIndex + 4)).join('.');
    headerLength = addressStartIndex + 4;
  } else if (addressType === 2) { // Domain
    const domainLength = view.getUint8(addressStartIndex);
    addressLength = domainLength + 1;
    domain = new TextDecoder().decode(buffer.slice(addressStartIndex + 1, addressStartIndex + 1 + domainLength));
    headerLength = addressStartIndex + 1 + domainLength;
  } else if (addressType === 3) { // IPv6
    addressLength = 16;
    // IPv6 parsing simplified
    headerLength = addressStartIndex + 16;
  }

  return {
    version,
    uuid,
    command,
    port,
    addressType,
    address,
    domain,
    headerLength
  };
}

// --- رابط کاربری ساده برای دریافت لینک ---

function renderHTML(request, hostname) {
  const vlessLink = `vless://${UUID}@${hostname}:443?encryption=none&security=tls&sni=${hostname}&fp=chrome&type=ws&host=${hostname}&path=%2F#FoxCloud-Worker`;
  
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <title>FoxCloud VLESS</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: system-ui, sans-serif; background: #1a1a1a; color: #fff; padding: 20px; display: flex; flex-direction: column; align-items: center; }
      .box { background: #2d2d2d; padding: 20px; border-radius: 10px; max-width: 600px; width: 100%; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
      h1 { color: #3498db; margin-top: 0; }
      code { background: #000; padding: 10px; display: block; word-wrap: break-word; border-radius: 5px; color: #2ecc71; font-family: monospace; margin: 10px 0; }
      button { background: #3498db; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; }
      button:hover { background: #2980b9; }
      .note { color: #f1c40f; font-size: 0.9em; margin-top: 15px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>🦊 FoxCloud VLESS</h1>
      <p>Status: <span style="color:#2ecc71">Active</span> | Protocol: <span style="color:#e67e22">VLESS+WS+TLS</span></p>
      
      <p>Copy the configuration below to your client (v2rayNG, V2Box, Streisand):</p>
      <code>${vlessLink}</code>
      <button onclick="navigator.clipboard.writeText('${vlessLink}').then(()=>alert('Copied!'))">📋 Copy to Clipboard</button>
      
      <div class="note">
        <strong>Gaming Setup:</strong> Enable "Tun Mode" or "VPN Mode" in your client settings.
      </div>
    </div>
  </body>
  </html>
  `;
}
