<script lang="ts">
  import { exportAnalyticsToCsv, type PF1eBattleReport } from "../../packages/pf1e/analytics";

  let { report }: { report: PF1eBattleReport } = $props();

  function downloadCsv() {
    const csv = exportAnalyticsToCsv(report);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `pf1e_battle_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
</script>

<div class="pf1e-analysis">
  <header class="analysis-header">
    <h3>PF1e Battle Analysis (High Fidelity)</h3>
    <button class="btn-csv" type="button" onclick={downloadCsv}>Export CSV</button>
  </header>

  <div class="summary-cards">
    <div class="card">
      <span class="label">Total Attacks</span>
      <span class="val">{report.totals.totalAttacks}</span>
    </div>
    <div class="card">
      <span class="label">Hit Rate</span>
      <span class="val">{report.totals.hitPercentage}%</span>
    </div>
    <div class="card">
      <span class="label">Net Damage</span>
      <span class="val">{report.totals.netDamageDealt}</span>
    </div>
    <div class="card">
      <span class="label">Kills</span>
      <span class="val">{report.totals.killsCount}</span>
    </div>
    <div class="card">
      <span class="label">DR Absorbed</span>
      <span class="val">{report.totals.drAbsorbed}</span>
    </div>
    <div class="card">
      <span class="label">DR Bypassed</span>
      <span class="val">{report.totals.drBypassed}</span>
    </div>
    <div class="card">
      <span class="label">Misfires</span>
      <span class="val">{report.totals.misfiresCount}</span>
    </div>
    <div class="card">
      <span class="label">SR Blocked</span>
      <span class="val">{report.totals.srBlocked}</span>
    </div>
    <div class="card">
      <span class="label">Saves Passed</span>
      <span class="val">{report.totals.savesPassed} / {report.totals.savesPassed + report.totals.savesFailed}</span>
    </div>
  </div>

  <table class="analysis-table">
    <thead>
      <tr>
        <th>Unit ID</th>
        <th>Attacks</th>
        <th>Hits</th>
        <th>Hit %</th>
        <th>Misfires</th>
        <th>Damage</th>
        <th>Kills</th>
        <th>DR Abs.</th>
        <th>DR Byp.</th>
      </tr>
    </thead>
    <tbody>
      {#each Object.values(report.units) as u (u.unitId)}
        <tr>
          <td>{u.unitId}</td>
          <td>{u.totalAttacks}</td>
          <td>{u.hits}</td>
          <td>{u.hitPercentage}%</td>
          <td>{u.misfiresCount}</td>
          <td>{u.netDamageDealt}</td>
          <td>{u.killsCount}</td>
          <td>{u.drAbsorbed}</td>
          <td>{u.drBypassed}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .pf1e-analysis {
    padding: 12px;
    font-size: 13px;
    color: #e0e0e0;
  }
  .analysis-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .btn-csv {
    background: #2b5278;
    color: white;
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .summary-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  .card {
    background: #1a1a24;
    padding: 8px;
    border-radius: 4px;
    text-align: center;
  }
  .card .label {
    display: block;
    font-size: 11px;
    color: #a0a0b0;
  }
  .card .val {
    font-size: 16px;
    font-weight: bold;
    color: #4da6ff;
  }
  .analysis-table {
    width: 100%;
    border-collapse: collapse;
  }
  .analysis-table th, .analysis-table td {
    padding: 6px;
    text-align: left;
    border-bottom: 1px solid #2a2a38;
  }
  .analysis-table th {
    background: #14141e;
    color: #8a8ab0;
  }
</style>
