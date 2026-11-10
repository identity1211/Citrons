"use strict";

const fs = require("fs");
const path = require("path");

function prizeEmail() {
  return String(process.env.PRIZE_EMAIL || "").trim().toLowerCase();
}

function volumeDir() {
  return String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim().replace(/\/$/, "");
}

function prizeFile() {
  const set = String(process.env.PRIZE_FILE || "").trim();
  if (set) return set;
  const vol = volumeDir();
  if (vol) {
    const onVolume = path.join(vol, "present.pdf");
    if (fs.existsSync(onVolume)) return onVolume;
  }
  return path.join(__dirname, "private", "present.pdf");
}

function sentFlagFile() {
  const vol = volumeDir();
  return path.join(vol || path.join(__dirname, "private"), "prize-sent.json");
}

function alreadySent(email) {
  try {
    const data = JSON.parse(fs.readFileSync(sentFlagFile(), "utf8"));
    return !!(data && data[email]);
  } catch {
    return false;
  }
}

function markSent(email) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(sentFlagFile(), "utf8")) || {};
  } catch {
    data = {};
  }
  data[email] = Date.now();
  const file = sentFlagFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function prizeReady() {
  return !!(prizeEmail() && process.env.RESEND_API_KEY && process.env.PRIZE_FROM && fs.existsSync(prizeFile()));
}

/**
 * Sends present.pdf once, and only to PRIZE_EMAIL.
 * ok means the winner should see that the prize was sent.
 */
async function deliverPrize({ to }) {
  const expected = prizeEmail();
  const dest = String(to || "").trim().toLowerCase();
  if (!expected || dest !== expected) return { ok: false, reason: "not-recipient" };
  if (alreadySent(dest)) return { ok: true, reason: "already" };
  const key = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.PRIZE_FROM || "").trim();
  const file = prizeFile();
  if (!key || !from || !fs.existsSync(file)) {
    console.error("prize: mail is not configured");
    return { ok: false, reason: "unconfigured" };
  }
  const buf = fs.readFileSync(file);
  const letter = prizeLetter();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [dest],
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
      attachments: [{ filename: "present.pdf", content: buf.toString("base64") }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("prize: send failed", res.status, text.slice(0, 180));
    return { ok: false, reason: "send" };
  }
  markSent(dest);
  console.log("prize: sent");
  return { ok: true, reason: "sent" };
}

function prizeLetter() {
  const text = [
    "Поздравляем!",
    "",
    "Дорогая Марта Мария, вы выиграли свой первый турнир в Secret Code!",
    "",
    "А я выиграл эту жизнь, ведь у меня самая лучшая, нежная, любящая красавица жена! Это были потрясающие 2 совместных года и впереди еще не один десяток лет! Я тебя очень люблю!",
    "",
    "Твой любящий муж!",
    "",
    "P.S. Твой подарок во вложении.",
    "P.S.S. Я очень хочу, чтобы ты чувствовала себя самой красивой в каждый момент суток, даже ночью, когда ты сладко спишь.",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <title>Поздравляем!</title>
</head>
<body style="margin:0;padding:0;background:#3a1420;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#3a1420;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff7f1;border-radius:20px;overflow:hidden;">
          <tr><td style="height:10px;background:#9d3048;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="height:6px;background:#e7c56a;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:34px 36px 8px;font-family:Georgia,'Times New Roman',serif;">
              <div style="font-size:12px;letter-spacing:4px;font-weight:700;color:#9d3048;">SECRET CODE</div>
              <div style="margin-top:16px;font-size:40px;line-height:1.15;font-style:italic;color:#3a1820;">Поздравляем!</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 36px 0;font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.65;color:#3a241c;">
              Дорогая Марта Мария, вы выиграли свой первый турнир в Secret Code!
            </td>
          </tr>
          <tr>
            <td style="padding:16px 36px 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#4a2c28;">
              А я выиграл эту жизнь, ведь у меня самая лучшая, нежная, любящая красавица жена! Это были потрясающие 2 совместных года и впереди еще не один десяток лет! Я тебя очень люблю!
            </td>
          </tr>
          <tr>
            <td align="right" style="padding:22px 36px 8px;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-style:italic;color:#9d3048;">
              Твой любящий муж!
            </td>
          </tr>
          <tr>
            <td style="padding:8px 36px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff0e4;border-radius:12px;">
                <tr>
                  <td style="padding:14px 16px;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;color:#6a3040;">
                    <strong style="color:#9d3048;">P.S.</strong> Твой подарок во вложении.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 36px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8efe0;border-radius:12px;">
                <tr>
                  <td style="padding:14px 16px;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;color:#5c4630;">
                    <strong style="color:#a6843a;">P.S.S.</strong> Я очень хочу, чтобы ты чувствовала себя самой красивой в каждый момент суток, даже ночью, когда ты сладко спишь.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height:6px;background:#e7c56a;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="height:10px;background:#9d3048;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: "Поздравляем!", text, html };
}

module.exports = { deliverPrize, prizeReady, prizeEmail, prizeLetter };
