/**
 * WeChat QR-code login flow.
 *
 * Fetches a QR code, displays it in the terminal, polls its status
 * until the user scans and confirms, then saves the resulting token
 * to ~/.wechat-pi-acp/config.json.
 */

import type { ActiveLogin, LoginOptions, LoginResult } from "../types.js";
import { DEFAULT_BOT_TYPE, FIXED_BASE_URL, fetchQRCode, pollQRStatus } from "./api.js";
import { saveConfig } from "../config.js";

/** Maximum number of QR code refreshes before giving up. */
const MAX_QR_REFRESH_COUNT = 3;
/** Total time to wait for the user to scan and confirm (8 minutes). */
const DEFAULT_WAIT_TIMEOUT_MS = 480_000;

let activeLogin: ActiveLogin | null = null;
let scannedPrinted = false;

/** Render the QR code in the terminal via qrcode-terminal, with a fallback URL. */
async function displayQRCode(qrcodeUrl: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
    process.stdout.write("\n若二维码未能显示或无法使用，你可以访问以下链接以继续：\n");
    process.stdout.write(`${qrcodeUrl}\n\n`);
  } catch {
    process.stdout.write("\n若二维码未能显示或无法使用，你可以访问以下链接以继续：\n");
    process.stdout.write(`${qrcodeUrl}\n\n`);
  }
}

/** Read a single line from stdin for verify-code input. */
async function readStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      resolve(chunk.toString().trim());
    });
  });
}

/** Refresh the QR code (called when it expires or verification is blocked). */
async function refreshQR(botType: string, qrRefreshCount: number): Promise<boolean> {
  process.stdout.write(`\n正在刷新二维码...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
  try {
    const resp = await fetchQRCode(FIXED_BASE_URL, botType);
    activeLogin!.qrcode = resp.qrcode;
    activeLogin!.qrcodeUrl = resp.qrcode_img_content;
    activeLogin!.startedAt = Date.now();
    scannedPrinted = false;
    process.stdout.write(`二维码已更新，请重新扫描。\n\n`);
    await displayQRCode(resp.qrcode_img_content);
    return true;
  } catch (err) {
    process.stderr.write(`刷新二维码失败: ${(err as Error).message}\n`);
    return false;
  }
}

/**
 * Run the full QR login flow:
 *   1. Fetch QR code
 *   2. Display it in the terminal
 *   3. Poll status until confirmed, handling refresh/errors along the way
 *   4. Save the resulting token to config
 */
export async function loginWithQR(opts?: LoginOptions): Promise<LoginResult> {
  const botType = opts?.botType || DEFAULT_BOT_TYPE;
  const verbose = opts?.verbose || false;

  process.stdout.write("\n正在获取二维码...\n");
  let resp;
  try {
    resp = await fetchQRCode(FIXED_BASE_URL, botType);
  } catch (err) {
    throw new Error(`获取二维码失败: ${(err as Error).message}`);
  }

  activeLogin = {
    qrcode: resp.qrcode,
    qrcodeUrl: resp.qrcode_img_content,
    startedAt: Date.now(),
  };
  scannedPrinted = false;

  process.stdout.write("\n用手机微信扫描以下二维码，以继续连接：\n\n");
  await displayQRCode(resp.qrcode_img_content);
  process.stdout.write("正在等待扫码... ");

  let currentBaseUrl = FIXED_BASE_URL;
  let pendingVerifyCode: string | undefined = undefined;
  let qrRefreshCount = 1;
  const deadline = Date.now() + DEFAULT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let statusResp;
    try {
      statusResp = await pollQRStatus(currentBaseUrl, activeLogin.qrcode, pendingVerifyCode);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        process.stdout.write(".");
        continue;
      }
      process.stdout.write(`\n轮询错误: ${(err as Error).message}, 重试中...\n`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    switch (statusResp.status) {
      case "wait":
        if (verbose) process.stdout.write(".");
        break;

      case "scaned":
        pendingVerifyCode = undefined;
        if (!scannedPrinted) {
          process.stdout.write("\n正在验证\n");
          scannedPrinted = true;
        }
        break;

      case "need_verifycode": {
        const prompt = pendingVerifyCode
          ? "❌ 你输入的数字不匹配，请重新输入："
          : "输入手机微信显示的数字，以继续连接：";
        pendingVerifyCode = await readStdin(prompt);
        continue;
      }

      case "expired":
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) throw new Error("二维码多次失效，连接流程已停止。请稍后再试。");
        if (!(await refreshQR(botType, qrRefreshCount))) throw new Error("刷新二维码失败");
        break;

      case "verify_code_blocked":
        pendingVerifyCode = undefined;
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) throw new Error("多次输入错误，连接流程已停止。请稍后再试。");
        if (!(await refreshQR(botType, qrRefreshCount))) throw new Error("刷新二维码失败");
        break;

      case "scaned_but_redirect": {
        if (statusResp.redirect_host) {
          currentBaseUrl = `https://${statusResp.redirect_host}`;
          process.stdout.write(`\n重定向到 ${currentBaseUrl}\n`);
        }
        break;
      }

      case "binded_redirect":
        throw new Error("已连接过，无需重复连接。");

      case "confirmed": {
        if (!statusResp.bot_token || !statusResp.ilink_bot_id) {
          throw new Error("登录确认但服务端未返回 bot_token");
        }
        process.stdout.write("\n登录成功！\n");

        const result: LoginResult = {
          botToken: statusResp.bot_token,
          ilinkBotId: statusResp.ilink_bot_id,
          ilinkUserId: statusResp.ilink_user_id || "",
          baseUrl: statusResp.baseurl || FIXED_BASE_URL,
        };

        // Persist the login result to config
        saveConfig({
          token: result.botToken,
          ilinkBotId: result.ilinkBotId,
          ilinkUserId: result.ilinkUserId,
          baseUrl: result.baseUrl,
        });

        activeLogin = null;
        return result;
      }

      default:
        process.stdout.write(`\n未知状态: ${statusResp.status}\n`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("登录超时，请重试。");
}
