const http = require('http');
const https = require('https');
const tls = require('tls');

// Proxy Configuration (Defaults to user's current private proxy, overridable by environment variables)
const PROXY_HOST = process.env.PROXY_HOST || '45.85.162.159';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8000', 10);
const PROXY_USER = process.env.PROXY_USER || 'ruS4jQ';
const PROXY_PASS = process.env.PROXY_PASS || 'vqmUuA';
const PORT = process.env.PORT || 3000;

const PROXY_AUTH = 'Basic ' + Buffer.from(PROXY_USER + ':' + PROXY_PASS).toString('base64');

// Send standard CORS headers
function writeCorsHeaders(res, statusCode, extraHeaders = {}) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        ...extraHeaders
    };
    res.writeHead(statusCode, headers);
}

// Perform HTTPS Request through HTTP Tunneling (CONNECT method)
function requestViaProxy(targetUrl, clientReq, clientRes, redirectCount = 0) {
    if (redirectCount > 5) {
        writeCorsHeaders(clientRes, 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        clientRes.end('Error: Too many redirects');
        return;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (e) {
        writeCorsHeaders(clientRes, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
        clientRes.end('Error: Invalid target URL: ' + targetUrl);
        return;
    }

    console.log(`[Proxy Request] [Redirect: ${redirectCount}] ${clientReq.method} ${targetUrl} via ${PROXY_HOST}:${PROXY_PORT}`);

    // Establish CONNECT tunnel to Proxy
    const connectOptions = {
        host: PROXY_HOST,
        port: PROXY_PORT,
        method: 'CONNECT',
        path: parsedUrl.hostname + ':443',
        headers: {
            'Proxy-Authorization': PROXY_AUTH,
            'Host': parsedUrl.hostname
        }
    };

    const tunnelReq = http.request(connectOptions);

    tunnelReq.on('connect', (res, socket, head) => {
        if (res.statusCode !== 200) {
            console.error(`[Proxy Tunnel Error] Status: ${res.statusCode} for tunnel to ${parsedUrl.hostname}`);
            writeCorsHeaders(clientRes, 502, { 'Content-Type': 'text/plain; charset=utf-8' });
            clientRes.end(`Error: Tunnel connection failed (HTTP ${res.statusCode})`);
            return;
        }

        // Establish TLS handshake on top of the established socket
        const tlsSocket = tls.connect({
            socket: socket,
            servername: parsedUrl.hostname
        }, () => {
            // Send actual HTTPS request
            const pathWithQuery = parsedUrl.pathname + parsedUrl.search;
            
            // Spoof Referer and Origin to bypass video host anti-hotlinking
            const headers = {
                'Host': parsedUrl.hostname,
                'Referer': 'https://opstream90.com/',
                'Origin': 'https://opstream90.com',
                'User-Agent': clientReq.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };

            // Copy Authorization or other client-sent headers if present
            if (clientReq.headers['range']) {
                headers['Range'] = clientReq.headers['range'];
            }

            const httpsReq = https.request({
                hostname: parsedUrl.hostname,
                path: pathWithQuery,
                method: clientReq.method,
                headers: headers,
                createConnection: () => tlsSocket
            }, (httpsRes) => {
                // Handle Redirects (301, 302, 307, 308) automatically
                if ([301, 302, 307, 308].includes(httpsRes.statusCode) && httpsRes.headers.location) {
                    let redirectUrl = httpsRes.headers.location;
                    if (!redirectUrl.startsWith('http')) {
                        redirectUrl = new URL(redirectUrl, targetUrl).href;
                    }
                    console.log(`[Redirect Detected] Redirecting to ${redirectUrl}`);
                    requestViaProxy(redirectUrl, clientReq, clientRes, redirectCount + 1);
                    return;
                }

                // Copy headers from target response to client response, setting CORS
                const responseHeaders = {};
                const copyHeaders = [
                    'content-type', 'content-length', 'content-range', 
                    'accept-ranges', 'cache-control', 'expires', 'etag', 'last-modified'
                ];
                copyHeaders.forEach(h => {
                    if (httpsRes.headers[h]) {
                        responseHeaders[h] = httpsRes.headers[h];
                    }
                });

                // Ensure proper CORS and access headers
                responseHeaders['Access-Control-Allow-Origin'] = '*';
                responseHeaders['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, OPTIONS';
                responseHeaders['Access-Control-Allow-Headers'] = '*';
                responseHeaders['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Content-Type';

                clientRes.writeHead(httpsRes.statusCode, responseHeaders);
                httpsRes.pipe(clientRes);
            });

            httpsReq.on('error', (err) => {
                console.error('[HTTPS Request Error]:', err.message);
                writeCorsHeaders(clientRes, 502, { 'Content-Type': 'text/plain; charset=utf-8' });
                clientRes.end('Error: Target server communication error: ' + err.message);
            });

            // Pipe request body if any (for POST/PUT requests)
            clientReq.pipe(httpsReq);
        });

        tlsSocket.on('error', (err) => {
            console.error('[TLS Socket Error]:', err.message);
            writeCorsHeaders(clientRes, 502, { 'Content-Type': 'text/plain; charset=utf-8' });
            clientRes.end('Error: TLS Handshake failed: ' + err.message);
        });
    });

    tunnelReq.on('error', (err) => {
        console.error('[Tunnel Connection Error]:', err.message);
        writeCorsHeaders(clientRes, 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        clientRes.end('Error: Unable to connect to proxy: ' + err.message);
    });

    tunnelReq.end();
}

// Create HTTP Server
const server = http.createServer((req, res) => {
    // Handle CORS preflight request
    if (req.method === 'OPTIONS') {
        writeCorsHeaders(res, 204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Healthcheck / welcome page
    if (url.pathname === '/' || url.pathname === '/index.html') {
        writeCorsHeaders(res, 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>CinePrivate Custom CORS Proxy is active!</h1><p>Usage: /proxy?url=ENCODED_TARGET_URL</p>');
        return;
    }

    // Proxy endpoint
    if (url.pathname === '/proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            writeCorsHeaders(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Error: Missing "url" parameter');
            return;
        }

        requestViaProxy(targetUrl, req, res);
    } else {
        writeCorsHeaders(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error: Endpoint not found');
    }
});

// Start listening
server.listen(PORT, () => {
    console.log(`CinePrivate Proxy Server is running on port ${PORT}`);
    console.log(`Active Private Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
});
