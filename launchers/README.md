# Launchers

Double-click starters for trying SUDS on one computer: `Start-SUDS.bat` (Windows), `Start-SUDS.command` (Mac), `start-suds.sh` (Linux). Each checks for Node.js 22+, starts the server in a window and opens the setup wizard.

**Evaluation and single-workstation use only.** Nothing restarts SUDS when the window is closed or the computer reboots, and it runs as whoever clicked it. A county deployment that other staff depend on runs SUDS as a service — systemd on Linux, NSSM on Windows — behind the county's certificate or reverse proxy, as `docs/DEPLOYMENT.md` describes. The data folder created here carries over to that unchanged.
