// Checks the Signature Version 4 implementation against the worked example in the Amazon S3 documentation
// ("Signature calculations for the authorization header", GET object with a Range header) and the shape Laissez
// sends for a locked PUT. Run with npm run test:sigv4.
import { sigV4 } from '../api/src/siem';

let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) console.log(`PASS  ${name}`); else { fail++; console.log(`FAIL  ${name} ${extra}`); } };

// AWS example: access key AKIAIOSFODNN7EXAMPLE, secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, us-east-1, 2013-05-24.
const auth = await sigV4({
  method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
  headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
  payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  region: 'us-east-1', service: 's3', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
});
ok('matches the AWS worked example signature', auth.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'), auth);
ok('credential scope and signed headers as documented', auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,'), auth);

const put = await sigV4({
  method: 'PUT', host: 's3.eu-west-1.amazonaws.com', path: '/laissez-audit-demo/laissez-audit/aster-vale/2026-10-07/1-500.ndjson',
  headers: { 'x-amz-content-sha256': 'abc', 'x-amz-date': '20261007T120000Z', 'x-amz-object-lock-mode': 'COMPLIANCE', 'x-amz-object-lock-retain-until-date': '2033-10-05T12:00:00Z', 'content-type': 'application/x-ndjson' },
  payloadHash: 'abc', region: 'eu-west-1', service: 's3', accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', amzDate: '20261007T120000Z',
});
ok('a locked PUT signs the Object Lock headers', /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date,/.test(put), put);

console.log(fail ? `\n${fail} check(s) failed.` : '\nsigv4: all passed');
process.exit(fail ? 1 : 0);
