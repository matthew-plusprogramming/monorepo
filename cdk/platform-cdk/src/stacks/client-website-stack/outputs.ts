import type { AcmCertificate } from '@cdktf/provider-aws/lib/acm-certificate';
import type { CloudfrontDistribution } from '@cdktf/provider-aws/lib/cloudfront-distribution';
import type { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

import type { DomainConfig } from './config';

export const createOutputs = (
  scope: Construct,
  bucket: S3Bucket,
  distribution: CloudfrontDistribution,
  certificate: AcmCertificate,
  domainConfig: DomainConfig,
): void => {
  new TerraformOutput(scope, 'clientWebsiteBucketName', {
    value: bucket.bucket,
    description: 'Name of the client website asset bucket',
  });

  new TerraformOutput(scope, 'clientWebsiteDistributionId', {
    value: distribution.id,
    description: 'ID of the CloudFront distribution serving the client website',
  });

  new TerraformOutput(scope, 'clientWebsiteDistributionDomainName', {
    value: distribution.domainName,
    description: 'Domain name of the CloudFront distribution',
  });

  new TerraformOutput(scope, 'clientWebsiteDistributionHostedZoneId', {
    value: distribution.hostedZoneId,
    description:
      'Hosted zone ID of the CloudFront distribution (for alias records)',
  });

  new TerraformOutput(scope, 'clientWebsiteCertificateArn', {
    value: certificate.arn,
    description: 'ARN of the ACM certificate for the client website domain(s)',
  });

  new TerraformOutput(scope, 'clientWebsiteDomainName', {
    value: domainConfig.domainNames[0],
    description: 'Primary domain name for the client website',
  });

  new TerraformOutput(scope, 'clientWebsiteAlternateDomainNames', {
    value: domainConfig.domainNames.slice(1),
    description: 'Alternate domain names configured for the client website',
  });
};
