/**
 * Integration script to verify SMTP configuration by sending a real test email.
 * Run with: npm run test:email
 *
 * This is NOT part of the automated test suite — it hits a live SMTP server
 * and requires valid credentials in .env.
 */
import 'dotenv/config';
import { loadConfig } from '../src/infrastructure/config.js';
import { SmtpMailer } from '../src/infrastructure/mailer/smtp-mailer.js';
import { EpubDocument } from '../src/domain/values/epub-document.js';

const config = loadConfig();
const mailer = new SmtpMailer({
  kindle: config.kindle,
  sender: config.sender,
  smtp: config.smtp,
});

// Minimal valid EPUB (ZIP magic bytes + enough structure for a real send)
const minimalEpub = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, // ZIP local file header signature
]);

const doc = new EpubDocument('SMTP Configuration Test', minimalEpub);

console.log(`Sending test email to ${config.kindle.email} via ${config.smtp.host}:${config.smtp.port}...`);

const result = await mailer.send(doc);

if (result.ok) {
  console.log('✓ Email sent successfully. Check your Kindle inbox.');
} else {
  console.error(`✗ Failed (${result.error.cause}): ${result.error.message}`);
  process.exit(1);
}
