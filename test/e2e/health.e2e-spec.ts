import { ApiClient } from './support/api';

describe('Health (e2e)', () => {
    const api = new ApiClient();

    it('reports the gateway as up', async () => {
        const response = await api.get('/health');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'ok', service: 'api-gateway' });
    });

    it('reports the runtime service and its Docker hosts', async () => {
        const response = await api.get('/health/runtime');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ service: 'runtime-service', status: 'ok' });
        expect(response.body.hosts).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'local' })]),
        );
    });
});
