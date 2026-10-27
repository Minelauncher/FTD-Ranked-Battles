// Community account mail. Only Script Properties contain the shared secret.
// No inbox access, analytics, recipient logs, addresses, or client-side credentials.
function output_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return output_({service: 'community-account-mail', version: 1}); }
function authorizeMail() { return MailApp.getRemainingDailyQuota(); } // Permission only; sends nothing.
function same_(left, right) {
  if (typeof right !== 'string' || left.length !== right.length) return false;
  var different = 0;
  for (var i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}
function doPost(e) {
  var lock, locked = false, id = null;
  try {
    var raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 24000) return output_({ok: false, code: 'invalid'});
    var envelope = JSON.parse(raw), props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('RELAY_SECRET');
    if (props.getProperty('RELAY_ENABLED') !== 'true' || !/^[a-f0-9]{64}$/.test(secret || '')) return output_({ok: false, code: 'disabled'});
    if (typeof envelope.payload !== 'string' || envelope.payload.length > 18000 || !/^[a-f0-9]{64}$/.test(envelope.signature || '')) return output_({ok: false, code: 'invalid'});
    var expected = Utilities.computeHmacSha256Signature(envelope.payload, secret, Utilities.Charset.UTF_8)
      .map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
    if (!same_(expected, envelope.signature)) return output_({ok: false, code: 'unauthorized'});
    var message = JSON.parse(envelope.payload), now = Math.floor(Date.now() / 1000);
    if (message.v !== 1 || !/^[a-f0-9]{32}$/.test(message.id || '') || !Number.isInteger(message.at) || message.at < now - 120 || message.at > now + 30) return output_({ok: false, code: 'expired'});
    id = message.id;
    if (typeof message.to !== 'string' || message.to.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(message.to) ||
        typeof message.subject !== 'string' || !message.subject.length || message.subject.length > 200 || /[\r\n\x00]/.test(message.subject) ||
        typeof message.body !== 'string' || !message.body.length || message.body.length > 16000 ||
        typeof message.name !== 'string' || !message.name.trim() || message.name.length > 80 || /[\r\n\x00]/.test(message.name)) return output_({ok: false, id: id, code: 'invalid'});
    // Until explicitly enabled for production, mail can ONLY go to the test mailbox.
    var testRecipient = (props.getProperty('TEST_RECIPIENT') || '').trim().toLowerCase();
    if (props.getProperty('PRODUCTION_ENABLED') !== 'true' && (!testRecipient || message.to !== testRecipient)) return output_({ok: false, id: id, code: 'test_only'});
    lock = LockService.getScriptLock();
    locked = lock.tryLock(2000);
    if (!locked) return output_({ok: false, id: id, code: 'busy'});
    var state = JSON.parse(props.getProperty('MAIL_STATE') || '[]');
    if (!Array.isArray(state) || state.length > 80 || state.some(function(x) { return !Array.isArray(x) || !/^[a-f0-9]{32}$/.test(x[0]) || !Number.isInteger(x[1]); })) return output_({ok: false, id: id, code: 'state_error'});
    state = state.filter(function(x) { return x[1] > now - 86400; });
    if (state.some(function(x) { return x[0] === id; })) return output_({ok: false, id: id, code: 'duplicate'});
    if (state.length >= 80 || MailApp.getRemainingDailyQuota() < 1) return output_({ok: false, id: id, code: 'daily_limit'});
    // Reserve before sending. An ambiguous failure must never resend the same mail.
    state.push([id, now]);
    props.setProperty('MAIL_STATE', JSON.stringify(state));
    MailApp.sendEmail({to: message.to, subject: message.subject, body: message.body, name: message.name});
    return output_({ok: true, id: id});
  } catch (error) {
    // Never log recovery contents, email addresses, signatures, or exception details.
    return output_({ok: false, id: id, code: 'send_failed'});
  } finally {
    if (locked) lock.releaseLock();
  }
}
