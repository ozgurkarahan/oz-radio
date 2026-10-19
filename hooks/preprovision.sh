#!/bin/sh
# azd preprovision hook — fail closed unless authentication is configured.
# Values come from the azd environment (azd exports them to hooks). Secret values are never printed.
set -eu

get_value() {
  eval "v=\${$1:-}"
  if [ -z "$v" ]; then
    v=$(azd env get-value "$1" 2>/dev/null) || v=""
  fi
  printf '%s' "$v"
}

# AUTH_MODE is read from the azd environment ONLY, never from the process environment:
# run-local sets AUTH_MODE=disabled in developer shells, which must not decide a deployment.
# Checked first so that no other path (including ALLOW_INSECURE_NO_AUTH) can skip it.
auth_mode=$(azd env get-value AUTH_MODE 2>/dev/null) || auth_mode=""
auth_mode=$(printf '%s' "$auth_mode" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
if [ "$auth_mode" = "disabled" ]; then
  echo "ERROR: refusing to provision: AUTH_MODE=disabled is set in the azd environment." >&2
  echo "It makes every caller an admin and the deployed backend refuses it on Azure Container Apps anyway." >&2
  echo "Fix it with: azd env set AUTH_MODE easyauth" >&2
  echo "To test production as an admin use Entra bearer tokens (AUTH_EXTRA_CLIENT_APPS): docs/provisioning.md section 3.1" >&2
  exit 1
fi

insecure=$(get_value ALLOW_INSECURE_NO_AUTH | tr '[:upper:]' '[:lower:]')
missing=""
for name in AUTH_CLIENT_ID AUTH_CLIENT_SECRET ALLOWED_OBJECT_IDS; do
  if [ -z "$(get_value "$name" | tr -d '[:space:]')" ]; then
    missing="$missing $name"
  fi
done

if [ -n "$missing" ]; then
  if [ "$insecure" = "true" ]; then
    echo ""
    echo "############################################################################"
    echo "#  WARNING: ALLOW_INSECURE_NO_AUTH=true — provisioning WITHOUT Easy Auth."
    echo "#  Missing:$missing"
    echo "#  The app will be public and read-only: nobody can sign in or act as admin."
    echo "############################################################################"
    echo ""
    exit 0
  fi
  echo "ERROR: refusing to provision without authentication. Missing azd env values:$missing" >&2
  echo "Set them with: azd env set AUTH_CLIENT_ID <app-id>; azd env set AUTH_CLIENT_SECRET <secret>; azd env set ALLOWED_OBJECT_IDS <oid1,oid2>" >&2
  echo "Or, for a throw-away public read-only demo only: azd env set ALLOW_INSECURE_NO_AUTH true" >&2
  exit 1
fi

guid_re='^[0-9a-fA-F]\{8\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{12\}$'
is_guid() { printf '%s' "$1" | tr -d '[:space:]' | grep -q "$guid_re"; }

bad=""
is_guid "$(get_value AUTH_CLIENT_ID)" || bad="$bad AUTH_CLIENT_ID"
tenant=$(get_value AUTH_TENANT_ID)
if [ -n "$tenant" ]; then is_guid "$tenant" || bad="$bad AUTH_TENANT_ID"; fi
oids=$(get_value ALLOWED_OBJECT_IDS)
old_ifs=$IFS; IFS=','
for oid in $oids; do
  if ! is_guid "$oid"; then bad="$bad ALLOWED_OBJECT_IDS"; break; fi
done
IFS=$old_ifs
if [ -n "$bad" ]; then
  echo "ERROR: expected GUID value(s) in:$bad (ALLOWED_OBJECT_IDS is a comma-separated list of GUIDs)" >&2
  exit 1
fi

echo "preprovision: Easy Auth configuration present (AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, ALLOWED_OBJECT_IDS)."
exit 0