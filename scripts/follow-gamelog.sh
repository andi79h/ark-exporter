#!/bin/sh
# follow-gamelog.sh <ShooterGame/Saved/Logs> – prints new lines of the newest ServerGame.*.log and switches to the
# newer file after a server restart. For ark-rcon maps whose log files are on another machine:
#   "logCommand": ["sh", "-c", "ssh -o BatchMode=yes user@host sh -s /path/to/Logs < scripts/follow-gamelog.sh"]
# The first file is followed from its end, later files from their start. Empty lines are keep-alives (ignored).
set -u
dir=$1
cur=""
pid=""
trap 'if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi' EXIT INT TERM HUP
while :; do
  new=$(ls "$dir" | grep -E '^ServerGame\.[0-9]+\.[0-9]{4}\.[0-9]{2}\.[0-9]{2}_[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.log$' | sort -t. -k3,7 | tail -1)
  if [ -n "$new" ] && [ "$new" != "$cur" ]; then
    if [ -n "$pid" ]; then sleep 2; kill "$pid" 2>/dev/null; fi
    if [ -z "$cur" ]; then from=0; else from=+1; fi
    tail -n "$from" -F "$dir/$new" 2>/dev/null &
    pid=$!
    cur=$new
  fi
  # an empty line now and then: when the reader (e.g. the ssh connection) is gone, the write fails and the script ends
  echo "" || exit 0
  sleep 5
done
