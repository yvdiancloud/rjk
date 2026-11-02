#!/bin/sh
set -eu

certbot renew --quiet --deploy-hook "systemctl reload nginx"
