'use client';

import { useState } from 'react';
import { MermaidDiagram } from './MermaidDiagram';

type DiagramType = 'architecture' | 'cicd' | 'dataflow';

interface DiagramInfo {
  id: DiagramType;
  label: string;
  description: string;
  chart: string;
}

const diagrams: DiagramInfo[] = [
  {
    id: 'architecture',
    label: 'System Architecture',
    description: 'OCI IaaS 기반 전체 인프라 구성',
    chart: `flowchart TB
    subgraph Internet["🌐 Internet"]
        User["👤 User"]
        Dev["👨‍💻 Developer"]
    end

    subgraph GitHub["GitHub"]
        Repo["📁 Repository<br/>swkoo-kr"]
        Actions["⚡ GitHub Actions<br/>CI Pipeline"]
    end

    subgraph OCI["☁️ OCI Cloud"]
        subgraph Registry["Container Registry"]
            OCIR["🐳 OCI Registry<br/>icn.ocir.io"]
        end
        
        subgraph Compute["Compute Instance"]
            subgraph K3s["🚀 K3s Cluster"]
                subgraph argocd["argocd namespace"]
                    ArgoCD["🔄 Argo CD<br/>GitOps Controller"]
                end
                
                subgraph monitoring["monitoring namespace"]
                    Prometheus["📊 Prometheus"]
                    Grafana["📈 Grafana"]
                end
                
                subgraph swkoo["swkoo namespace"]
                    Backend["🔧 Backend<br/>NestJS"]
                    Frontend["🎨 Frontend<br/>Next.js"]
                end

                Ingress["🚪 Traefik Ingress"]
            end
        end
    end

    User -->|"HTTPS"| Ingress
    Ingress --> Frontend
    Ingress --> Backend
    Ingress --> Grafana
    Ingress --> ArgoCD

    Dev -->|"git push"| Repo
    Repo -->|"trigger"| Actions
    Actions -->|"build & push"| OCIR
    ArgoCD -->|"pull image"| OCIR
    ArgoCD -->|"sync"| Repo
    ArgoCD -->|"deploy"| swkoo

    Prometheus -->|"scrape"| Backend
    Prometheus -->|"scrape"| Frontend
    Grafana -->|"query"| Prometheus`,
  },
  {
    id: 'cicd',
    label: 'CI/CD Pipeline',
    description: 'Code에서 Production까지의 자동화 흐름',
    chart: `flowchart LR
    subgraph Commit["1️⃣ Commit"]
        Push["git push"]
    end

    subgraph CI["2️⃣ CI - GitHub Actions"]
        Checkout["Checkout"]
        Lint["Lint & Test"]
        Build["Docker Build"]
        PushImg["Push to OCIR"]
    end

    subgraph CD["3️⃣ CD - Argo CD"]
        Detect["Detect Changes"]
        Sync["Sync Application"]
        Deploy["Rolling Update"]
    end

    subgraph Runtime["4️⃣ Runtime"]
        Pod["Running Pods"]
        Health["Health Check"]
    end

    Push --> Checkout
    Checkout --> Lint
    Lint --> Build
    Build --> PushImg
    
    PushImg -.->|"image pushed"| Detect
    Detect --> Sync
    Sync --> Deploy
    
    Deploy --> Pod
    Pod --> Health

    style Push fill:#10b981,color:#0f172a
    style PushImg fill:#3b82f6,color:#f1f5f9
    style Deploy fill:#8b5cf6,color:#f1f5f9
    style Health fill:#10b981,color:#0f172a`,
  },
  {
    id: 'dataflow',
    label: 'Data & Event Flow',
    description: 'Observatory 데이터 수집 및 표시 흐름',
    chart: `flowchart TB
    subgraph Sources["📡 Data Sources"]
        GH["GitHub API<br/>Workflow Runs"]
        Argo["Argo CD API<br/>Application Status"]
        Prom["Prometheus<br/>Metrics"]
    end

    subgraph Backend["🔧 Backend Service"]
        GHClient["GitHub Client"]
        ArgoClient["Argo CD Client"]
        Cache["In-Memory Cache<br/>TTL: 60s"]
        API["REST API<br/>/api/pipelines"]
    end

    subgraph Frontend["🎨 Frontend"]
        SSR["Server-Side Render"]
        Components["React Components"]
        UI["Observatory UI"]
    end

    GH -->|"fetch"| GHClient
    Argo -->|"fetch"| ArgoClient
    GHClient --> Cache
    ArgoClient --> Cache
    Cache --> API

    API -->|"revalidate: 15s"| SSR
    SSR --> Components
    Components --> UI
    
    Prom -.->|"future: SSE"| UI`,
  },
];

export function ArchitectureDiagram() {
  const [activeTab, setActiveTab] = useState<DiagramType>('architecture');
  const activeDiagram = diagrams.find((d) => d.id === activeTab) ?? diagrams[0];

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-2">
        {diagrams.map((diagram) => (
          <button
            key={diagram.id}
            onClick={() => setActiveTab(diagram.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === diagram.id
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 hover:text-slate-200'
            }`}
          >
            {diagram.label}
          </button>
        ))}
      </div>

      {/* Diagram Description */}
      <p className="text-sm text-slate-400">{activeDiagram.description}</p>

      {/* Mobile-only scroll hint. The container below scrolls
          horizontally because the mermaid output is min-w-[600px];
          without a hint the affordance is invisible on small screens. */}
      <p
        className="font-mono text-[11px] text-slate-500 sm:hidden"
        aria-hidden
      >
        ↔ 좌우로 스크롤해 전체 다이어그램 보기
      </p>

      {/* Diagram container. Single inner frame — the outer caller
          (e.g. /about page) should NOT double-wrap. The right-edge
          gradient is a soft cue that more content lives off-screen. */}
      <div
        className="relative overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 p-6"
        role="region"
        aria-label={`${activeDiagram.label} diagram (horizontally scrollable)`}
        tabIndex={0}
      >
        <MermaidDiagram chart={activeDiagram.chart} className="min-w-[600px]" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-slate-900/80 to-transparent sm:hidden"
        />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <span className="size-3 rounded bg-emerald-500"></span>
          Success/Active
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded bg-blue-500"></span>
          CI Process
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded bg-purple-500"></span>
          CD Process
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded border border-dashed border-slate-500"></span>
          Future/Planned
        </span>
      </div>
    </div>
  );
}

