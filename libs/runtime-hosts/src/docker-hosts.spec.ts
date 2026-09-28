import { describeEndpoint, loadDockerHosts } from './docker-hosts';

describe('loadDockerHosts', () => {
    it('defaults to one local host on the default socket', () => {
        expect(loadDockerHosts({})).toEqual([{ id: 'local', endpoint: 'default', maxWorkspaces: 8 }]);
    });

    it('uses DOCKER_SOCKET_PATH and HOST_MAX_WORKSPACES for the local host', () => {
        expect(
            loadDockerHosts({ DOCKER_SOCKET_PATH: '/var/run/docker.sock', HOST_MAX_WORKSPACES: '4' }),
        ).toEqual([{ id: 'local', endpoint: 'unix:///var/run/docker.sock', maxWorkspaces: 4 }]);
    });

    it.each(['0', '-3', 'lots'])('ignores an invalid HOST_MAX_WORKSPACES of %j', (value) => {
        expect(loadDockerHosts({ HOST_MAX_WORKSPACES: value })[0].maxWorkspaces).toBe(8);
    });

    it('reads the JSON form', () => {
        const hosts = loadDockerHosts({
            HOST_MAX_WORKSPACES: '5',
            DOCKER_HOSTS: JSON.stringify([
                { id: 'local', endpoint: '/var/run/docker.sock' },
                { id: 'eu-1', endpoint: 'tcp://10.0.0.12:2376', certPath: '/etc/corven/certs/eu-1', maxWorkspaces: 20 },
                { id: 'eu-2', endpoint: 'ssh://corven@10.0.0.13', maxWorkspaces: 12.7 },
            ]),
        });

        expect(hosts).toEqual([
            { id: 'local', endpoint: 'unix:///var/run/docker.sock', maxWorkspaces: 5, certPath: undefined },
            { id: 'eu-1', endpoint: 'tcp://10.0.0.12:2376', maxWorkspaces: 20, certPath: '/etc/corven/certs/eu-1' },
            { id: 'eu-2', endpoint: 'ssh://corven@10.0.0.13', maxWorkspaces: 12, certPath: undefined },
        ]);
    });

    it('reads the short id=endpoint form', () => {
        expect(
            loadDockerHosts({
                HOST_MAX_WORKSPACES: '3',
                DOCKER_HOSTS: 'local=/var/run/docker.sock, eu-1=tcp://10.0.0.12:2376',
            }),
        ).toEqual([
            { id: 'local', endpoint: 'unix:///var/run/docker.sock', maxWorkspaces: 3 },
            { id: 'eu-1', endpoint: 'tcp://10.0.0.12:2376', maxWorkspaces: 3 },
        ]);
    });

    it.each([
        ['[not json', /not valid JSON/],
        ['{"id":"a"}', /Invalid host id|should be id=endpoint/],
        ['[{"id":"a"}]', /needs "id" and "endpoint"/],
        ['[]', /lists no hosts/],
        ['no-equals-sign', /should be id=endpoint/],
        ['=tcp://x', /should be id=endpoint/],
        ['Local=/var/run/docker.sock', /Invalid host id/],
        ['a=/x.sock,a=/y.sock', /Duplicate host id "a"/],
    ])('rejects DOCKER_HOSTS=%j', (value, message) => {
        expect(() => loadDockerHosts({ DOCKER_HOSTS: value })).toThrow(message);
    });
});

describe('describeEndpoint', () => {
    it('removes passwords so endpoints are safe to log', () => {
        expect(describeEndpoint('ssh://corven:hunter2@10.0.0.13')).toBe('ssh://corven@10.0.0.13');
    });

    it('keeps sockets and the default as they are', () => {
        expect(describeEndpoint('unix:///var/run/docker.sock')).toBe('unix:///var/run/docker.sock');
        expect(describeEndpoint('default')).toBe('default socket');
    });
});
