const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const { Gaxios } = require('gaxios');
const withSession = require('dockerode/lib/session');
const { loadNycConfig } = require('@istanbuljs/load-nyc-config');

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readBody(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

function getBoundary(contentType) {
    const prefix = 'multipart/related; boundary=';
    expect(contentType.startsWith(prefix)).toBe(true);
    const boundary = contentType.slice(prefix.length);
    expect(boundary).toMatch(uuidV4);
    return boundary;
}

describe('scoped security dependency compatibility', () => {
    test('Dockerode generates a v4 session ID before opening a connection', () => {
        const connectionError = new Error('offline contract: connection not opened');
        const dial = jest.fn((options, callback) => {
            expect(options.method).toBe('POST');
            expect(options.path).toBe('/session');
            expect(options.headers['X-Docker-Expose-Session-Uuid']).toMatch(uuidV4);
            callback(connectionError);
        });
        const handler = jest.fn((err, sessionId, close) => {
            expect(err).toBe(connectionError);
            expect(sessionId).toBeNull();
            expect(close()).toBeUndefined();
        });

        withSession({ modem: { dial } }, {}, handler);

        expect(dial).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('Google Drive SDK builds multipart upload boundaries with the real common adapter', async () => {
        const request = jest.fn(async options => {
            const boundary = getBoundary(options.headers['content-type']);
            const body = await readBody(options.data);
            expect(options.params.uploadType).toBe('multipart');
            expect(body).toContain(`--${boundary}\r\ncontent-type: application/json`);
            expect(body).toContain(JSON.stringify({ name: 'fixture.txt' }));
            expect(body).toContain('offline upload fixture');
            expect(body.endsWith(`--${boundary}--`)).toBe(true);
            return { data: { id: 'offline-file-id' } };
        });
        const drive = google.drive({ version: 'v3', auth: { request } });

        const response = await drive.files.create({
            requestBody: { name: 'fixture.txt' },
            media: { mimeType: 'text/plain', body: 'offline upload fixture' }
        });

        expect(request).toHaveBeenCalledTimes(1);
        expect(response.data.id).toBe('offline-file-id');
    });

    test('Gaxios builds multipart bodies through a local adapter without HTTP', async () => {
        const adapter = jest.fn(async options => {
            const boundary = getBoundary(options.headers['Content-Type']);
            const body = await readBody(options.body);
            expect(body).toContain(`--${boundary}\r\nContent-Type: text/plain`);
            expect(body).toContain('offline gaxios fixture');
            expect(body.endsWith(`--${boundary}--`)).toBe(true);
            return { status: 200, data: 'accepted', config: options };
        });
        const client = new Gaxios({
            adapter,
            fetchImplementation: () => {
                throw new Error('network access is not permitted in this contract');
            }
        });

        const response = await client.request({
            url: 'https://offline.invalid/upload',
            method: 'POST',
            noProxy: ['offline.invalid'],
            multipart: [{ headers: { 'Content-Type': 'text/plain' }, content: 'offline gaxios fixture' }]
        });

        expect(adapter).toHaveBeenCalledTimes(1);
        expect(response.data).toBe('accepted');
    });

    test('Istanbul loads YAML extends, arrays and booleans with the scoped parser update', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamcaster-nyc-config-'));
        try {
            fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'offline-nyc-fixture' }));
            fs.writeFileSync(path.join(directory, 'base.yml'), [
                'all: true',
                'include:',
                '  - src/**/*.js',
                'extension:',
                '  - .js'
            ].join('\n'));
            fs.writeFileSync(path.join(directory, '.nycrc.yaml'), [
                'extends: ./base.yml',
                'check-coverage: true',
                'reporter:',
                '  - text',
                '  - lcov',
                'exclude:',
                '  - "**/*.test.js"'
            ].join('\n'));

            const config = await loadNycConfig({ cwd: directory, nycrcPath: '.nycrc.yaml' });

            expect(config.cwd).toBe(directory);
            expect(config.all).toBe(true);
            expect(config.checkCoverage).toBe(true);
            expect(config.include).toEqual(['src/**/*.js']);
            expect(config.extension).toEqual(['.js']);
            expect(config.exclude).toEqual(['**/*.test.js']);
            expect(config.reporter).toEqual(['text', 'lcov']);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
