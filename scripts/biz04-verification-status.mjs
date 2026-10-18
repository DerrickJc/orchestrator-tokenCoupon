// Keep findings independent from whether HTTP or manual verification ran.
export function updateVerificationStatus(report) {
  const failed = report.checks.some(check => !check.pass);
  report.localStatus = failed ? 'FAIL_PRODUCT'
    : !report.error && report.sessionStatus === 'succeeded' && report.http?.status === 'PASS' ? 'PASS' : 'NOT_RUN';
  // Local automation cannot fill the separate human/web verification record.
  report.status = report.localStatus === 'FAIL_PRODUCT' ? 'FAIL_PRODUCT' : 'NOT_RUN';
  return report;
}

export function httpAcceptancePassed(tap, exitCode) {
  const count = name => {
    const match = tap.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : undefined;
  };
  return exitCode === 0 && count('tests') === 25 && count('pass') === 25
    && ['fail', 'cancelled', 'skipped', 'todo'].every(name => count(name) === 0);
}
