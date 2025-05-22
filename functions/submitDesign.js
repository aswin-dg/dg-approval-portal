const path = require('path');
const fs = require('fs');
const { google } = require("googleapis");
const { Readable } = require("stream");
const sharp = require("sharp");
const { GoogleAuth } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");

const SHEET_ID = "15savw3NvzVurjuXAmCgm70SldnhE3V05OnAXX0CSTL8";
const FOLDER_ID = "12ocOXOcPFullB06KYeDWTOms9wLC9b6Q";
const LOGO_PATH = path.join(__dirname, 'DGlogo.png');
const DISCLAIMER_TEXT = "Note: Respected Customer, the font size, logo size etc, will be printed same exactly as seen here. Your proof once approved, the printing process will be started within 10 minutes. So, further correction will not be encouraged. Incase of any correction, you are requested to bear the processing charges till the processed stage. The delivery schedule also  will be changed.";

exports.handler = async function (event, context) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const busboy = require("busboy");
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    const bb = busboy({ headers: { "content-type": contentType } });

    let orderNumber = "";
    let fileBuffer = Buffer.from([]);

    return await new Promise((resolve, reject) => {
      bb.on("field", (name, val) => {
        if (name === "orderNumber") orderNumber = val;
      });

      bb.on("file", (_, file) => {
        file.on("data", (data) => {
          fileBuffer = Buffer.concat([fileBuffer, data]);
        });
      });

      bb.on("finish", async () => {
        if (!orderNumber || !fileBuffer.length) {
          return resolve({
            statusCode: 400,
            body: "Missing order number or file",
          });
        }

        const logoBuffer = fs.readFileSync(LOGO_PATH);
        const metadata = await sharp(fileBuffer).metadata();
        const width = metadata.width;
        const height = metadata.height;

        const watermarkLogo = await sharp(logoBuffer)
          .resize({ width: Math.floor(width / 6) })
          .png()
          .toBuffer();

        const watermarkTiles = [];
        const rows = 3;
        const cols = 3;
        const stepY = Math.floor(height / rows);
        const stepX = Math.floor(width / cols);

        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            watermarkTiles.push({
              input: watermarkLogo,
              top: row * stepY,
              left: col * stepX,
              blend: "overlay",
              opacity: 0.1
            });
          }
        }

        const watermarked = await sharp(fileBuffer)
          .composite(watermarkTiles)
          .toBuffer();

        const disclaimerHeight = 180;

        const resizedLogo = await sharp(logoBuffer)
          .resize({ height: 100 })
          .toBuffer();

        const disclaimerSvg = `
          <svg width="${width}" height="${disclaimerHeight}">
            <style>
              .text { fill: black; font-size: 24px; font-family: sans-serif; }
            </style>
            <text x="140" y="60" class="text">${DISCLAIMER_TEXT}</text>
            <text x="140" y="120" class="text">Order No: ${orderNumber}</text>
          </svg>
        `;

        const disclaimerTextBuffer = Buffer.from(disclaimerSvg);
        const disclaimerTextImage = await sharp(disclaimerTextBuffer)
          .resize({ width })
          .png()
          .toBuffer();

        const disclaimerBox = await sharp({
          create: {
            width,
            height: disclaimerHeight,
            channels: 4,
            background: "#ffffff",
          }
        })
          .composite([
            { input: resizedLogo, top: 30, left: 20 },
            { input: disclaimerTextImage, top: 0, left: 0 }
          ])
          .png()
          .toBuffer();

        const finalImage = await sharp({
          create: {
            width,
            height: height + disclaimerHeight,
            channels: 4,
            background: "#ffffff",
          },
        })
          .composite([
            { input: watermarked, top: 0, left: 0 },
            { input: disclaimerBox, top: height, left: 0 }
          ])
          .png()
          .toBuffer();

        const auth = new google.auth.GoogleAuth({
          keyFile: "./credentials.json",
          scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"],
        });
        const authClient = await auth.getClient();
        const drive = google.drive({ version: "v3", auth: authClient });
        const sheets = google.sheets({ version: "v4", auth: authClient });

        const fileName = `${orderNumber}.png`;
        const fileMetadata = {
          name: fileName,
          parents: [FOLDER_ID],
        };
        const media = {
          mimeType: "image/png",
          body: Readable.from(finalImage),
        };
        const file = await drive.files.create({
          resource: fileMetadata,
          media: media,
          fields: "id",
        });

        const fileId = file.data.id;
        await drive.permissions.create({
          fileId,
          requestBody: {
            role: "reader",
            type: "anyone",
          },
        });
        const viewLink = `https://drive.google.com/uc?id=${fileId}`;

        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "Sheet1!A:B",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[orderNumber, viewLink]],
          },
        });

        resolve({
          statusCode: 200,
          body: JSON.stringify({ message: "Success", link: viewLink }),
        });
      });

      bb.end(Buffer.from(event.body, "base64"));
    });
  } catch (error) {
    return {
      statusCode: 500,
      body: "Server error: " + error.message,
    };
  }
};
