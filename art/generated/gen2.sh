#!/bin/bash
# like gen.sh but waits for a free slot (max 5 concurrent codex runs across both scripts)
while [ $(tasklist 2>/dev/null | grep -ci "codex") -gt 12 ]; do sleep 10; done
exec ./gen.sh "$@"
