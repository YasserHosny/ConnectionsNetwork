# Included by the server block and by every location that sets its own add_header (nginx drops
# inherited add_header lines in a location that declares any), so the policy is written once.
# Rendered by envsubst at container start; SUPABASE_URL is the project origin from the same
# environment that writes runtime-config.json (the entrypoint refuses anything but a bare origin).
#
#   script-src 'self'          no inline script: index.html must not carry any (angular.json
#                              turns critical-CSS inlining off, because its loader is an inline script).
#   style-src ... unsafe-inline  Angular components and Material set <style> elements and style
#                              attributes at runtime; there is no nonce for them.
#   font-src 'self'            fonts are self-hosted (Readex Pro, the icons); no font CDN.
#   img-src data:              the TOTP enrolment QR code is a data: URI.
#   connect-src SUPABASE_URL   sign-in, MFA and token refresh talk to Supabase directly.
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${SUPABASE_URL}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
# The contributor page keeps its link token in the URL fragment; nothing about the page address
# may leave through a Referer either.
add_header Referrer-Policy "no-referrer" always;
