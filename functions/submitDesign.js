const { google } = require("googleapis");
const { Readable } = require("stream");
const sharp = require("sharp");
const { GoogleAuth } = require("google-auth-library");
const { JWT } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");

const SHEET_ID = "15savw3NvzVurjuXAmCgm70SldnhE3V05OnAXX0CSTL8";
const FOLDER_ID = "12ocOXOcPFullB06KYeDWTOms9wLC9b6Q";
const LOGO_PATH = "./assets/dg-logo.png";
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

        const fs = require("fs");
        const logoBuffer = fs.readFileSync(LOGO_PATH);

        const metadata = await sharp(fileBuffer).metadata();
        const width = metadata.width;
        const watermarkLogo = await sharp(logoBuffer)
          .resize(100)
          .png()
          .toBuffer();

        const watermarked = await sharp(fileBuffer)
          .composite([
            ...Array.from({ length: 4 }, (_, row) =>
              Array.from({ length: 4 }, (_, col) => ({
                input: watermarkLogo,
                top: row * (width / 4),
                left: col * (width / 4),
                blend: "overlay",
                gravity: "center",
                tile: false,
                opacity: 0.1,
              }))
            ).flat(),
          ])
          .toBuffer();

        const disclaimerHeight = 150;
        const disclaimerBox = await sharp({
          create: {
            width,
            height: disclaimerHeight,
            channels: 4,
            background: "#ffffff",
          },
        })
          .composite([
            { input: logoBuffer, top: disclaimerHeight - 100, left: 20 },
          ])
          .png()
          .toBuffer();

        const finalImage = await sharp({
          create: {
            width,
            height: metadata.height + disclaimerHeight,
            channels: 4,
            background: "#ffffff",
          },
        })
          .composite([
            { input: watermarked, top: 0, left: 0 },
            { input: disclaimerBox, top: metadata.height, left: 0 },
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