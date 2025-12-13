import { AcmCertificate } from '@cdktf/provider-aws/lib/acm-certificate';
import { CloudfrontDistribution } from '@cdktf/provider-aws/lib/cloudfront-distribution';
import { CloudfrontFunction } from '@cdktf/provider-aws/lib/cloudfront-function';
import { CloudfrontOriginAccessControl } from '@cdktf/provider-aws/lib/cloudfront-origin-access-control';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import type { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { Route53Record } from '@cdktf/provider-aws/lib/route53-record';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { S3BucketObject } from '@cdktf/provider-aws/lib/s3-bucket-object';
import { S3BucketOwnershipControls } from '@cdktf/provider-aws/lib/s3-bucket-ownership-controls';
import { S3BucketPolicy } from '@cdktf/provider-aws/lib/s3-bucket-policy';
import { S3BucketPublicAccessBlock } from '@cdktf/provider-aws/lib/s3-bucket-public-access-block';
import { Fn } from 'cdktf';
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

export const createHtmlRewriteFunction = (
  scope: Construct,
): CloudfrontFunction =>
  new CloudfrontFunction(scope, 'clientWebsiteHtmlRewriteFunction', {
    name: `${STACK_PREFIX}-client-website-html-rewrite`,
    runtime: 'cloudfront-js-1.0',
    publish: true,
    comment: 'Rewrite extensionless routes to .html for Next export.',
    code: [
      'function handler(event) {',
      '  var request = event.request;',
      '  var uri = request.uri;',
      '',
      "  if (uri === '/') {",
      "    request.uri = '/index.html';",
      '    return request;',
      '  }',
      '',
      "  if (uri.indexOf('/_next') === 0) {",
      '    return request;',
      '  }',
      '',
      "  if (uri.length > 1 && uri.charAt(uri.length - 1) === '/') {",
      '    uri = uri.substring(0, uri.length - 1);',
      '  }',
      '',
      '  var lastSlash = uri.lastIndexOf("/");',
      '  var lastSegment = uri.substring(lastSlash + 1);',
      '',
      '  if (lastSegment.indexOf(".") === -1) {',
      '    request.uri = uri + ".html";',
      '    return request;',
      '  }',
      '',
      '  request.uri = uri;',
      '  return request;',
      '}',
      '',
    ].join('\n'),
  });

export const createCertificateResources = (
  scope: Construct,
  domainConfig: DomainConfig,
  provider: AwsProvider,
): AcmCertificate =>
  new AcmCertificate(scope, 'clientWebsiteCertificate', {
    domainName: domainConfig.domainNames[0],
    subjectAlternativeNames: domainConfig.domainNames.slice(1),
    validationMethod: 'DNS',
    provider,
  });

export const createDistribution = (
  scope: Construct,
  bucket: S3Bucket,
  originAccessControl: CloudfrontOriginAccessControl,
  rewriteFunction: CloudfrontFunction,
  certificate: AcmCertificate,
  domainNames: string[],
): CloudfrontDistribution => {
  const originId = `${STACK_PREFIX}-client-website-origin`;

  return new CloudfrontDistribution(scope, 'clientWebsiteDistribution', {
    aliases: domainNames,
    comment: `${CLIENT_WEBSITE_STACK_NAME} distribution`,
    defaultRootObject: 'index.html',
    enabled: true,
    isIpv6Enabled: true,
    priceClass: 'PriceClass_All',
    customErrorResponse: [
      {
        errorCode: 403,
        responseCode: 404,
        responsePagePath: '/404.html',
        errorCachingMinTtl: 0,
      },
      {
        errorCode: 404,
        responseCode: 404,
        responsePagePath: '/404.html',
        errorCachingMinTtl: 0,
      },
    ],
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
      functionAssociation: [
        {
          eventType: 'viewer-request',
          functionArn: rewriteFunction.arn,
        },
      ],
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
  const hostedZoneId = domainConfig.hostedZoneId;
  if (!hostedZoneId) {
    return;
  }

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
      zoneId: hostedZoneId,
    });
  });
};
