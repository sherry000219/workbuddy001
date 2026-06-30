const { execSync } = require('child_process');
const userId = '16553702451766789';
try {
  const cmd = 'chcp 65001 >nul 2>&1 && dws contact user get --user-id "' + userId + '" --format json';
  console.log('Running cmd:', cmd);
  const output = execSync(cmd, { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
  console.log('Output length:', output.length);
  const data = JSON.parse(output);
  const results = data.result || [];
  console.log('Results count:', results.length);
  if (results.length > 0) {
    const u = results[0];
    const emp = u.orgEmployeeModel || {};
    console.log('jobNumber:', emp.jobNumber);
    console.log('name:', emp.orgUserName);
    console.log('dept:', emp.depts && emp.depts[0] && emp.depts[0].deptName);
  }
} catch(e) {
  console.log('Error:', e.message.substring(0, 200));
  console.log('Status:', e.status);
  if (e.stderr) console.log('Stderr:', e.stderr.substring(0, 200));
}
