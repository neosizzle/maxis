# MAXIS Water Operations

A frontend demo dashboard for the MAXIS membrane water-treatment prototype. It brings the simulated installation, water and energy monitoring, maintenance workflows, alerts, and a resident supply view into one interface.

> **Prototype status:** all readings and operational commands in this app are simulated. The Live API option currently displays a clear notice; no backend, sensor, membrane controller, or physical equipment is connected.

## Features

- Interactive 3D treatment installation with selectable equipment, orbit and zoom controls, and a 2D schematic fallback.
- Overview of rainwater storage, source, treated-water turbidity, flow, solar generation, alerts, and installation status.
- Water monitoring for pre- and post-filter turbidity and pressure, pressure difference, bulk-meter usage, and mains-backup readings.
- Energy monitoring with solar, pump, UV, and miscellaneous loads, plus historical charts.
- Maintenance workspace for turbidity trends, clean-filter baseline, service tasks, inventory, internal supply orders, and incident records.
- Alert acknowledgment, simulated source switching, emergency stop and reset, device status, heartbeat, and event logs.
- Resident view with shared-installation usage, service notices, and a local issue-report form.
- Demo and Live API mode selector. Live API mode explains that the application continues to use demo data until an adapter is connected.

## Requirements

- Node.js 22.12 or newer
- npm

## Run locally

From the project directory, install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (by default, `http://127.0.0.1:5173/`). Keep the development server running while using the dashboard.

Build and preview the production bundle with:

```bash
npm run build
npm run preview
```

Run the automated checks with:

```bash
npm test
```

## Demo walkthrough

1. On **Overview**, select **Full-screen plant view**. Select equipment in the 3D scene to inspect its readings and history. Use the 2D schematic control if WebGL is unavailable.
2. Choose **Filter Degradation** in the demo scenario selector. Review the membrane warning, elevated outlet turbidity, pressure difference, and related alert.
3. Open **Alerts & system** and acknowledge the membrane alert. Acknowledgment records receipt; the alert remains active while its condition persists.
4. In **Operational controls**, switch the source to mains backup. The simulator confirms the command and updates source usage.
5. In **Maintenance**, create a membrane service task, record completion, and review supplies used. You can also move a supply order through Draft, Ordered, and Received.
6. Choose **Recovery**, then switch the source back to rainwater.
7. Try **Emergency stop** and **Reset & restart** to demonstrate the stop latch. Choose **Sensor Offline** to show stale readings and disabled controls, then return to **Normal**.
8. Switch to the resident view to inspect shared usage and submit a local demo issue report. Return to the operator view to find the report in maintenance incidents.

Use **Reset demo** to clear local workflow changes and restore the default simulated installation.

## Data and integration status

The simulator updates every two seconds and seeds up to 24 hours of illustrative history. Rainwater storage is configured at 10,000 L. Mains pressure and turbidity are simulated; **mains capacity monitoring is unavailable because no capacity sensor is fitted**. The displayed turbidity trend is a screening indicator based on the selected history range, not a membrane-life prediction.

The operator/resident switch is for demonstrating separate views; it is not authentication or access control. Workflow records are stored locally in the browser. Source changes, stop/reset actions, orders, and reports do not control real equipment or contact external services.

See [INTEGRATION.md](INTEGRATION.md) for the future `DataSource` interface and [QA.md](QA.md) for test and verification notes.

## Technology

- React 19 and TypeScript
- Vite
- Three.js with React Three Fiber and Drei
- Recharts
- Lucide icons
