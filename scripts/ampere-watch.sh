#!/usr/bin/env bash
# ============================================================================
# ampere-watch.sh — grab a free Oracle Ampere A1 instance the moment capacity
# opens, then tell you so you can move the Valhalla engine onto it.
#
# WHY: Oracle's Always-Free Ampere A1 (up to 4 OCPU / 24 GB) is ~10-15x faster
# per routing call than the E2.1.Micro the engine runs on today — fast enough
# that the camera-peel reaches its true floor (Tiburon→Atherton ~6 cameras)
# instead of stalling on the micro VM's 1/8-core CPU. The catch is that A1
# capacity is almost always "Out of host capacity"; the only reliable way to
# get one is to retry a launch in a loop until it slips through.
#
# WHAT IT DOES: every INTERVAL seconds it tries `oci compute instance launch`,
# rotating through your availability domains. "Out of host capacity" / 500s are
# expected and just trigger a retry. On success it prints the instance OCID,
# waits for the public IP, fires a desktop + optional webhook notification, and
# exits. A successful run CREATES a real (free-tier) instance.
#
# PREREQS (one-time):
#   1. Install the OCI CLI:  brew install oci-cli      (macOS)
#   2. Configure it:         oci setup config          (needs your user OCID,
#      tenancy OCID, region, and an API key — the wizard walks you through it
#      and prints the API public key to paste into the OCI console under your
#      user → API Keys).
#   3. Fill in scripts/ampere.env (see ampere.env.example). Run this script with
#      --discover first to list the OCIDs you need.
#
# USAGE:
#   bash scripts/ampere-watch.sh --discover     # list ADs / images / subnets
#   bash scripts/ampere-watch.sh                # watch + grab (default)
#   INTERVAL=60 bash scripts/ampere-watch.sh    # faster polling
#
# Keep your laptop awake while it runs:  caffeinate -is bash scripts/ampere-watch.sh
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${AMPERE_ENV:-$HERE/ampere.env}"

# ---- load config ----------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# Required (from ampere.env or environment):
#   COMPARTMENT_ID   ocid1.compartment...  (or tenancy OCID for the root compartment)
#   SUBNET_ID        ocid1.subnet...       (a public subnet in your VCN)
#   IMAGE_ID         ocid1.image...        (an aarch64/ARM image, e.g. Ubuntu 22.04 aarch64)
#   SSH_KEY_FILE     path to your *.pub    (authorized for the new instance)
#   ADS              comma-separated availability domain names
# Optional:
SHAPE="${SHAPE:-VM.Standard.A1.Flex}"
OCPUS="${OCPUS:-4}"
MEM_GB="${MEM_GB:-24}"
BOOT_GB="${BOOT_GB:-50}"
DISPLAY_NAME="${DISPLAY_NAME:-deflock-valhalla-a1}"
INTERVAL="${INTERVAL:-120}"          # seconds between attempts
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}" # optional: POSTed a JSON message on success

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1'. $2"; exit 1; }; }
need oci "Install with: brew install oci-cli"

# ---- discovery helper -----------------------------------------------------
if [ "${1:-}" = "--discover" ]; then
  : "${COMPARTMENT_ID:?Set COMPARTMENT_ID in $ENV_FILE first (your compartment or tenancy OCID)}"
  echo "== Availability domains =="
  oci iam availability-domain list --compartment-id "$COMPARTMENT_ID" \
    --query 'data[].name' --raw-output 2>/dev/null || echo "  (check OCI auth / COMPARTMENT_ID)"
  echo
  echo "== Latest Ubuntu 22.04 aarch64 (ARM) images =="
  oci compute image list --compartment-id "$COMPARTMENT_ID" \
    --operating-system "Canonical Ubuntu" --operating-system-version "22.04" \
    --shape "$SHAPE" --query 'data[0:5].{name:"display-name",ocid:id}' --output table 2>/dev/null \
    || echo "  (no images returned — verify region/compartment)"
  echo
  echo "== Subnets in this compartment =="
  oci network subnet list --compartment-id "$COMPARTMENT_ID" \
    --query 'data[].{name:"display-name",ocid:id,public:"prohibit-public-ip-on-vnic"}' \
    --output table 2>/dev/null || echo "  (none — create a VCN with a public subnet first)"
  exit 0
fi

# ---- validate config ------------------------------------------------------
missing=0
for v in COMPARTMENT_ID SUBNET_ID IMAGE_ID SSH_KEY_FILE ADS; do
  if [ -z "${!v:-}" ]; then echo "Config missing: $v"; missing=1; fi
done
[ "$missing" -eq 0 ] || { echo "Fill in $ENV_FILE (copy ampere.env.example), then re-run. Use --discover to find OCIDs."; exit 1; }
[ -f "$SSH_KEY_FILE" ] || { echo "SSH_KEY_FILE not found: $SSH_KEY_FILE"; exit 1; }

IFS=',' read -r -a AD_LIST <<< "$ADS"

notify() {
  local msg="$1"
  printf '\a'  # terminal bell
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$msg\" with title \"Ampere A1\" sound name \"Glass\"" >/dev/null 2>&1 || true
  fi
  if [ -n "$NOTIFY_WEBHOOK" ]; then
    curl -fsS -m 10 -X POST "$NOTIFY_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"$msg\"}" >/dev/null 2>&1 || true
  fi
}

echo "Watching for Ampere A1 capacity — $SHAPE ${OCPUS}ocpu/${MEM_GB}GB across ADs: ${AD_LIST[*]}"
echo "Retrying every ${INTERVAL}s. Ctrl-C to stop. (Keep this machine awake.)"
attempt=0
while true; do
  for ad in "${AD_LIST[@]}"; do
    attempt=$((attempt + 1))
    ts="$(date '+%H:%M:%S')"
    out="$(oci compute instance launch \
      --availability-domain "$ad" \
      --compartment-id "$COMPARTMENT_ID" \
      --shape "$SHAPE" \
      --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}" \
      --image-id "$IMAGE_ID" \
      --subnet-id "$SUBNET_ID" \
      --assign-public-ip true \
      --display-name "$DISPLAY_NAME" \
      --boot-volume-size-in-gbs "$BOOT_GB" \
      --ssh-authorized-keys-file "$SSH_KEY_FILE" \
      --wait-for-state RUNNING \
      --connection-timeout 20 \
      --read-timeout 60 \
      2>&1)"
    rc=$?

    if [ $rc -eq 0 ]; then
      ocid="$(echo "$out" | grep -oE 'ocid1\.instance\.[a-z0-9.._-]+' | head -1)"
      echo ""
      echo "================ GOT ONE in $ad (attempt #$attempt) ================"
      echo "Instance OCID: $ocid"
      ip="$(oci compute instance list-vnics --instance-id "$ocid" \
            --query 'data[0]."public-ip"' --raw-output 2>/dev/null)"
      echo "Public IP: ${ip:-<pending — check console>}"
      echo ""
      echo "Next: SSH in, install Docker, run scripts/deploy-engine.sh (the tile"
      echo "image is multi-arch so it runs on ARM as-is), open port 8002, then set"
      echo "VALHALLA_URL=http://$ip:8002 in Vercel and redeploy."
      notify "Ampere A1 acquired in $ad — IP ${ip:-pending}. Time to move the engine."
      exit 0
    fi

    if echo "$out" | grep -qiE "Out of host capacity|InternalError|500|too many requests|429"; then
      echo "[$ts] $ad: no capacity (attempt #$attempt) — retrying"
    elif echo "$out" | grep -qiE "LimitExceeded|already.*free|max.*reached"; then
      echo "[$ts] $ad: LIMIT — you may already have an A1 instance using your free quota:"
      echo "$out" | sed 's/^/    /' | head -4
      echo "    (Free tier = 4 OCPU / 24GB total across all A1 instances. Stop/terminate an old one or lower OCPUS/MEM_GB.)"
    elif echo "$out" | grep -qiE "NotAuthenticated|Authorization failed|NotAuthorizedOrNotFound"; then
      echo "[$ts] AUTH/CONFIG error — fix before continuing:"
      echo "$out" | sed 's/^/    /' | head -6
      exit 1
    else
      echo "[$ts] $ad: unexpected response (attempt #$attempt):"
      echo "$out" | sed 's/^/    /' | head -4
    fi
  done
  sleep "$INTERVAL"
done
