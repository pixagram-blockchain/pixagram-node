#!/bin/bash
# Wrapper entrypoint for pixagram-haf container.
# Fixes file descriptor limits for PostgreSQL and hived processes.
# The HAF image's default entrypoint uses sudo/service to start PostgreSQL,
# which resets the soft nofile limit to 1024. During blockchain replay, the
# SQL serializer opens many parallel DB connections and exceeds this limit.

# NOTE (HAF 1.28.7 / v1.0.0): the image no longer has a haf_admin user. The
# container runs as `hived` and the entrypoint moved to /home/hived/.

# Write system limits (need sudo; the hived user has passwordless sudo here)
echo '* soft nofile 1048576' | sudo tee /etc/security/limits.d/99-nofile.conf > /dev/null
echo '* hard nofile 1048576' | sudo tee -a /etc/security/limits.d/99-nofile.conf > /dev/null

# Wrap pg_ctl binary to set ulimit before starting postgres
PG_CTL=/usr/lib/postgresql/17/bin/pg_ctl
if [ -f "$PG_CTL" ] && [ ! -f "${PG_CTL}.real" ]; then
    sudo mv "$PG_CTL" "${PG_CTL}.real"
    printf '#!/bin/bash\nulimit -n 1048576\nexec /usr/lib/postgresql/17/bin/pg_ctl.real "$@"\n' | sudo tee "$PG_CTL" > /dev/null
    sudo chmod +x "$PG_CTL"
fi

ulimit -n 1048576
exec /home/hived/docker_entrypoint.sh "$@"
