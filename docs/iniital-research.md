


i want to build a simple api testing system using bash, curl, jq etc. we can start with the gets. I think 
we can store expected response json in a folder structure and we need a script that could process a list of apis endpoints to hit and save the response. they could be below and fodler named after the endpoint. lots of questions, I sure so fire away
GET /api/agents
POST /api/agents
DELETE /api/agents/{name}
GET /api/agents/{name}
POST /api/agents/{name}/actions/resume
POST /api/agents/{name}/actions/send
POST /api/agents/{name}/actions/start
POST /api/agents/{name}/actions/suspend
POST /api/agents/{name}/actions/upload
GET /api/agents/{name}/config
GET /api/agents/{name}/info
GET /api/agents/{name}/logs

1. Folder Structure
apitest/
  endpoints.txt
  run.sh
  lib.sh

  expected/
    GET_api_agents.json
    GET_api_agents__name.json

  actual/
    (generated)

  diffs/
    (generated)
2. endpoints.txt (GETs only for now)

Use a simple format:

GET /api/agents
GET /api/agents/{name}
GET /api/system/health
GET /v1/models
3. lib.sh (core helpers)
#!/usr/bin/env bash

BASE_URL="${BASE_URL:-http://localhost:5000}"
AUTH_HEADER="${AUTH_HEADER:-}"

sanitize() {
  echo "$1" \
    | sed 's/{name}/test-agent/g' \
    | sed 's/[{}]/_/g' \
    | sed 's/\//_/g' \
    | sed 's/^_//'
}

url_expand() {
  echo "$1" \
    | sed 's/{name}/test-agent/g'
}

call_api() {
  local method="$1"
  local path="$2"

  local url="${BASE_URL}$(url_expand "$path")"

  curl -s \
    -X "$method" \
    -H "Content-Type: application/json" \
    ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
    "$url"
}

pretty() {
  jq -S . 2>/dev/null || cat
}

diff_json() {
  diff -u <(pretty < "$1") <(pretty < "$2")
}
4. run.sh (runner)
#!/usr/bin/env bash
set -e

source ./lib.sh

mkdir -p actual diffs

while read -r line; do
  [[ -z "$line" ]] && continue

  method=$(echo "$line" | awk '{print $1}')
  path=$(echo "$line" | awk '{print $2}')

  name=$(sanitize "${method}_${path}")

  actual_file="actual/${name}.json"
  expected_file="expected/${name}.json"
  diff_file="diffs/${name}.diff"

  echo "→ $method $path"

  call_api "$method" "$path" > "$actual_file"

  if [[ -f "$expected_file" ]]; then
    if diff_json "$expected_file" "$actual_file" > "$diff_file"; then
      echo "  OK"
      rm -f "$diff_file"
    else
      echo "  FAIL (see $diff_file)"
    fi
  else
    echo "  (no expected, capturing baseline)"
    cp "$actual_file" "$expected_file"
  fi

done < endpoints.txt
5. Usage
chmod +x run.sh lib.sh
./run.sh
6. Key Design Choices (important)
1. Baseline-first workflow

First run → captures expected

Later runs → diff against it

2. Deterministic JSON

jq -S sorts keys

avoids false diffs

3. Loose coupling

No OpenAPI dependency

No schema validation yet

Pure HTTP + JSON

7. Immediate Next Upgrades (worth doing)
Ignore volatile fields

Add a filter:

normalize() {
  jq 'del(.timestamp, .id, .requestId)' 2>/dev/null || cat
}

Then:

diff -u <(normalize < "$1" | jq -S .) \
         <(normalize < "$2" | jq -S .)
Status code validation

Capture headers:

curl -s -w "\n%{http_code}" ...

Split body/status.

Param expansion

Support matrix:

GET /api/agents/{name} name=test1
GET /api/agents/{name} name=test2
Parallel execution
cat endpoints.txt | xargs -P 8 -I {} bash -c './run_one.sh "{}"'
Tagging / grouping
[agents]
GET /api/agents
GET /api/agents/{name}

[system]
GET /api/system/health

Run subsets.

8. Questions that matter next

Answer these before going further:

Auth?

bearer token?

rotating?

Are responses stable?

timestamps?

IDs?

ordering?

Do you want:

strict equality

or "shape validation" (subset match)

Will agents create data?

need setup/teardown?

Do you want this:

dev tool

or CI gate?

9. Where this goes (if you keep pushing)

This evolves naturally into:

snapshot testing (what you’re doing)

contract testing (schema)

scenario testing (multi-call flows)

Without ever needing a heavy framework.