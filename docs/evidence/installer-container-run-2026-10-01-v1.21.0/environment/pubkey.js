// Prints the installed server's evidence-signing public key (what GET /api/admin/security/signing-key publishes).
process.stdout.write(require('/opt/suds/current/server/signing').publicInfo().public_key_pem);
