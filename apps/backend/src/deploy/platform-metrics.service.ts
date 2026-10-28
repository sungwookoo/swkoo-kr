import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';

export interface MetricSample { metric: Record<string, string>; value: [number, string] }

@Injectable()
export class PlatformMetricsService {
  async query(query: string, time = Date.now() / 1000): Promise<MetricSample[]> {
    try {
      const { data } = await axios.get('http://kube-prometheus-stack-prometheus.monitoring.svc:9090/api/v1/query', {
        params: { query, time }, timeout: 5000, maxContentLength: 2_000_000,
      });
      const rows = data?.data?.result;
      if (data?.status !== 'success' || data?.data?.resultType !== 'vector' || !Array.isArray(rows) ||
          rows.some(row => !row.metric || !Array.isArray(row.value) || !Number.isFinite(Number(row.value[1])))) throw Error('Invalid metrics');
      return rows;
    } catch {
      throw new ServiceUnavailableException({ reason: 'METRICS_UNAVAILABLE', message: '서버 사용량을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }
}
