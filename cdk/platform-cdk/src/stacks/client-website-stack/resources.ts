import { AcmCertificate } from '@cdktf/provider-aws/lib/acm-certificate';
import { AcmCertificateValidation } from '@cdktf/provider-aws/lib/acm-certificate-validation';
import { CloudfrontDistribution } from '@cdktf/provider-aws/lib/cloudfront-distribution';
import { CloudfrontOriginAccessControl } from '@cdktf/provider-aws/lib/cloudfront-origin-access-control';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import type { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { Route53Record } from '@cdktf/provider-aws/lib/route53-record';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { S3BucketObject } from '@cdktf/provider-aws/lib/s3-bucket-object';
import { S3BucketOwnershipControls } from '@cdktf/provider-aws/lib/s3-bucket-ownership-controls';
import { S3BucketPolicy } from '@cdktf/provider-aws/lib/s3-bucket-policy';
import { S3BucketPublicAccessBlock } from '@cdktf/provider-aws/lib/s3-bucket-public-access-block';
import { Fn, TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

import { STACK_PREFIX } from '../../constants';
import { CLIENT_WEBSITE_STACK_NAME } from '../names';

import type { DomainConfig } from './config';
import { inferContentType, resolveCacheControl, toPosixKey } from './config';

export interface WebsiteBucketResources {
  bucket: S3Bucket;
  ownershipControls: S3BucketOwnershipControls;
  publicAccessBlock: S3BucketPublicAccessBlock;
}

export const createWebsiteBucket = (
  scope: Construct,
  region: string,
): WebsiteBucketResources => {
  const bucket = new S3Bucket(scope, 'clientWebsiteBucket', {
    bucketPrefix: `${STACK_PREFIX}-client-website-`,
    forceDestroy: true,
    region,
  });

  const ownershipControls = new S3BucketOwnershipControls(
    scope,
    'clientWebsiteBucketOwnership',
    {
      bucket: bucket.bucket,
      rule: { objectOwnership: 'BucketOwnerEnforced' },
      region,
    },
  );

  const publicAccessBlock = new S3BucketPublicAccessBlock(
    scope,
    'clientWebsiteBucketPublicAccessBlock',
    {
      bucket: bucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
      region,
    },
  );

  return { bucket, ownershipControls, publicAccessBlock };
};

export const createOriginAccessControl = (
  scope: Construct,
): CloudfrontOriginAccessControl =>
  new CloudfrontOriginAccessControl(scope, 'clientWebsiteOriginAccessControl', {
    name: `${STACK_PREFIX}-client-website-oac`,
    originAccessControlOriginType: 's3',
    signingBehavior: 'always',
    signingProtocol: 'sigv4',
  });

export const createCertificateResources = (
  scope: Construct,
  domainConfig: DomainConfig,
  provider: AwsProvider,
): { certificate: AcmCertificate; validation: AcmCertificateValidation } => {
  const certificate = new AcmCertificate(scope, 'clientWebsiteCertificate', {
    domainName: domainConfig.domainNames[0],
    subjectAlternativeNames: domainConfig.domainNames.slice(1),
    validationMethod: 'DNS',
    provider,
  });

  const validationRecords = domainConfig.domainNames.map((_, index) => {
    const validationOption = certificate.domainValidationOptions.get(index);
    return new Route53Record(
      scope,
      `clientWebsiteCertificateValidationRecord-${index}`,
      {
        allowOverwrite: true,
        name: validationOption.resourceRecordName,
        type: validationOption.resourceRecordType,
        records: [validationOption.resourceRecordValue],
        ttl: 60,
        zoneId: domainConfig.hostedZoneId,
      },
    );
  });

  const validation = new AcmCertificateValidation(
    scope,
    'clientWebsiteCertificateValidation',
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: validationRecords.map((record) => record.fqdn),
      provider,
    },
  );

  return { certificate, validation };
};

export const createDistribution = (
  scope: Construct,
  bucket: S3Bucket,
  originAccessControl: CloudfrontOriginAccessControl,
  certificate: AcmCertificate,
  domainNames: string[],
  validation: AcmCertificateValidation,
): CloudfrontDistribution => {
  const originId = `${STACK_PREFIX}-client-website-origin`;

  return new CloudfrontDistribution(scope, 'clientWebsiteDistribution', {
    aliases: domainNames,
    comment: `${CLIENT_WEBSITE_STACK_NAME} distribution`,
    defaultRootObject: 'index.html',
    enabled: true,
    isIpv6Enabled: true,
    priceClass: 'PriceClass_All',
    origin: [
      {
        domainName: bucket.bucketRegionalDomainName,
        originAccessControlId: originAccessControl.id,
        originId,
        s3OriginConfig: { originAccessIdentity: '' },
      },
    ],
    defaultCacheBehavior: {
      allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
      cachedMethods: ['GET', 'HEAD'],
      compress: true,
      defaultTtl: 300,
      maxTtl: 86400,
      minTtl: 0,
      forwardedValues: {
        cookies: { forward: 'none' },
        queryString: false,
      },
      targetOriginId: originId,
      viewerProtocolPolicy: 'redirect-to-https',
    },
    restrictions: { geoRestriction: { restrictionType: 'none' } },
    viewerCertificate: {
      acmCertificateArn: certificate.arn,
      minimumProtocolVersion: 'TLSv1.2_2021',
      sslSupportMethod: 'sni-only',
    },
    dependsOn: [validation],
  });
};

export const createBucketPolicy = (
  scope: Construct,
  region: string,
  bucket: S3Bucket,
  distribution: CloudfrontDistribution,
): void => {
  const bucketPolicyDocument = new DataAwsIamPolicyDocument(
    scope,
    'clientWebsiteBucketPolicyDocument',
    {
      statement: [
        {
          actions: ['s3:GetObject'],
          resources: [`${bucket.arn}/*`],
          principals: [
            {
              type: 'Service',
              identifiers: ['cloudfront.amazonaws.com'],
            },
          ],
          condition: [
            {
              test: 'StringEquals',
              variable: 'AWS:SourceArn',
              values: [distribution.arn],
            },
          ],
        },
      ],
    },
  );

  new S3BucketPolicy(scope, 'clientWebsiteBucketPolicy', {
    bucket: bucket.bucket,
    policy: bucketPolicyDocument.json,
    region,
    dependsOn: [distribution],
  });
};

export const uploadWebsiteAssets = (
  scope: Construct,
  region: string,
  assetsRoot: string,
  resources: WebsiteBucketResources,
  assetFiles: string[],
): void => {
  assetFiles.forEach((filePath, index) => {
    const objectKey = toPosixKey(assetsRoot, filePath);
    new S3BucketObject(scope, `clientWebsiteObject-${index}`, {
      bucket: resources.bucket.bucket,
      key: objectKey,
      source: filePath,
      etag: Fn.filemd5(filePath),
      cacheControl: resolveCacheControl(objectKey),
      contentType: inferContentType(filePath),
      region,
      dependsOn: [resources.ownershipControls, resources.publicAccessBlock],
    });
  });
};

export const createAliasRecords = (
  scope: Construct,
  domainConfig: DomainConfig,
  distribution: CloudfrontDistribution,
): void => {
  domainConfig.domainNames.forEach((recordDomain, index) => {
    new Route53Record(scope, `clientWebsiteAliasRecord-${index}`, {
      alias: {
        evaluateTargetHealth: false,
        name: distribution.domainName,
        zoneId: distribution.hostedZoneId,
      },
      allowOverwrite: true,
      name: recordDomain,
      type: 'A',
      zoneId: domainConfig.hostedZoneId,
    });
  });
};

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
