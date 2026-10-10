#!/bin/bash
# The live test's MINOR-1: does a lock reveal that a username exists? Six wrong passwords for each name given ($@: an
# unknown name, and on a server whose first administrator may be locked for 15 minutes afterwards, "guest"). On 1.25.1
# an unknown name answered 401 every time while a real one was locked (423) after five; from 1.25.3 both answer alike.
for u in "$@"; do
  codes=$(for i in 1 2 3 4 5 6; do curl -sS -o /dev/null --cacert /root/pki/ca.pem -H 'Content-Type: application/json' -H 'X-Requested-With: suds' -d "{\"username\":\"$u\",\"password\":\"wrong-$i\"}" -w '%{http_code} ' https://suds.county.test/api/auth/login; done)
  echo "$u: $codes"
done
