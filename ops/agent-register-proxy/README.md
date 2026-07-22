# Fixed OpenAI Agent registration proxy

This service exposes one authenticated route only:

`POST /.well-known/cvt-agent-register`

It validates the JWT shape/required claims, the OpenSSH Ed25519 public key, and the exact registration payload before forwarding to the fixed OpenAI Agent registration endpoint. It never accepts an arbitrary upstream URL and never logs request bodies or tokens.

Set a random 32+ character `AGENT_REGISTER_PROXY_SECRET` in a local `.env`, bind the container to loopback, and publish only the fixed route through the dedicated DNS-only TLS hostname `agent-register.caoo.kdns.fr`.
