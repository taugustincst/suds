# Launchers — deprecated

**Deprecated as of SUDS 1.9.0; removal planned for a later release.** See
[`docs/PLATFORM.md`](../docs/PLATFORM.md): the web application served by the office SUDS server is the
only supported client, and the supported way to run that server is as a service (systemd on Linux, NSSM
on Windows) or in Docker, behind the county's certificate or reverse proxy, as `docs/DEPLOYMENT.md`
describes. The install guide no longer points here.

`Start-SUDS.bat` (Windows), `Start-SUDS.command` (Mac) and `start-suds.sh` (Linux) are double-click
starters that check for Node.js 22+, start the server in a window and open the setup wizard. They remain
in the tree for **evaluation on one computer only**: nothing restarts SUDS when the window is closed or
the computer reboots, and it runs as whoever clicked it. Do not use them for a deployment other staff
depend on. The data folder they create carries over unchanged to a service installation.
