import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config()



// interfaces
interface vpc {
    vpc_name: string;
    vpc_cidr: string;
    azs: string[];
    pub_sub_cidrs: string[];
    priv_sub_cidrs: string[];
  }

interface yourDetails {
    yourIP: string;
    yourAccessKey: string;
}

// define objects from config file
const vpc = config.requireObject<vpc>("vpc")
const yourDetails = config.requireObject<yourDetails>("yourDetails")

// ----NETWORKING----
// create VPC
const main = new aws.ec2.Vpc("main-vpc", {
    cidrBlock: vpc.vpc_cidr,
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: {
        Name: `${pulumi.getProject()}-${vpc.vpc_name}`,
        ManagedBy: "Pulumi"
    }
})

// create pub subs
const pub_sub = vpc.pub_sub_cidrs.map((subnet, index) => {
    return new aws.ec2.Subnet(`pub_sub${index+1}`, {
        cidrBlock: vpc.pub_sub_cidrs[index],
        vpcId: main.id,
        availabilityZone: vpc.azs[index],
        mapPublicIpOnLaunch:true,
        tags: {
            Name: `${pulumi.getProject()}-pub-sub${index+1}`,
            ManagedBy: "Pulumi"
        }
    })
})

// create priv subs
const priv_sub = vpc.priv_sub_cidrs.map((subnet, index) => {
    return new aws.ec2.Subnet(`priv_sub${index+1}`, {
        cidrBlock: vpc.priv_sub_cidrs[index],
        vpcId: main.id,
        availabilityZone: vpc.azs[index],
        mapPublicIpOnLaunch: false,
        tags: {
            Name: `${pulumi.getProject()}-priv-sub${index+1}`,
            ManagedBy: "Pulumi"
        }
    })
})

// create ig
const ig = new aws.ec2.InternetGateway("main-ig", {
    vpcId: main.id,
    tags: {
        Name: `${pulumi.getProject()}-ig`,
        ManagedBy: "Pulumi"
    }
})

// create rt
const pub_rt = new aws.ec2.RouteTable("pub_rt", {
    vpcId: main.id,
    routes: [
        {
            cidrBlock: "0.0.0.0/0",
            gatewayId: ig.id,
        }],
    tags: {
        Name: `${pulumi.getProject()}-rt`,
        ManagedBy: "Pulumi"
    }
});

// rt associations
const rt_associate = pub_sub.map((subnet, index) => {
    return new aws.ec2.RouteTableAssociation(`rt_associate-${index+1}`, {
        subnetId: subnet.id,
        routeTableId: pub_rt.id
    })
})


// ----SECURITY----

// create security group - SSH IN
const sg_ssh = new aws.ec2.SecurityGroup("allow-ssh", {
    description: "Allows SSH connections from the provided IP address",
    vpcId: main.id,

    tags: {
        Name: `${pulumi.getProject()}-sg-allow-ssh`,
        ManagedBy: "Pulumi"
    }
  });

  const sg_ssh_ingress = new aws.vpc.SecurityGroupIngressRule("ssh-ingress", {
    securityGroupId: sg_ssh.id,
    cidrIpv4: yourDetails.yourIP,
    fromPort: 22,
    ipProtocol: "tcp",
    toPort: 22,
  });

// create security group - HTTP
const sg_http = new aws.ec2.SecurityGroup("allow-http", {
    description: "Allow HTTP connections",
    vpcId: main.id,

    tags: {
        Name: `${pulumi.getProject()}-sg-allow-http`,
        ManagedBy: "Pulumi"
    }
  });

const sg_http_ingress80 = new aws.vpc.SecurityGroupIngressRule(
    "http-80-ingress",
    {
      securityGroupId: sg_http.id,
      cidrIpv4: "0.0.0.0/0",
      fromPort: 80,
      ipProtocol: "tcp",
      toPort: 80,
    }
  );

const sg_http_ingress3000 = new aws.vpc.SecurityGroupIngressRule(
    "http-3000-ingress",
    {
      securityGroupId: sg_http.id,
      cidrIpv4: "0.0.0.0/0",
      // need to figure out which port the app is listening on
      fromPort: 3000,
      ipProtocol: "tcp",
      toPort: 3000,
    }
  );

// const sg_https = new aws.ec2.SecurityGroup("allow-https", {
//     description: "Allow HTTPS connections",
//     vpcId: main.id,

//     tags: {
//       Name: "allow-https",
//     },
//   });

//   const sg_https_ingress80 = new aws.vpc.SecurityGroupIngressRule(
//     "https-80-ingress",
//     {
//       securityGroupId: sg_https.id,
//       cidrIpv4: "0.0.0.0/0",
//       fromPort: 80,
//       ipProtocol: "tcp",
//       toPort: 80,
//     }
//   );

//   const sg_https_ingress3000 = new aws.vpc.SecurityGroupIngressRule(
//     "https-3000-ingress",
//     {
//       securityGroupId: sg_https.id,
//       cidrIpv4: "0.0.0.0/0",
//       fromPort: 3000,
//       ipProtocol: "tcp",
//       toPort: 3000,
//     }
//   );

const sg_egress = new aws.ec2.SecurityGroup("allow-egress", {
    description: "Allow Egress connections",
    vpcId: main.id,

    tags: {
        Name: `${pulumi.getProject()}-sg-allow-egress`,
        ManagedBy: "Pulumi"
    }
  });

const sg_egress_rule = new aws.vpc.SecurityGroupEgressRule("egress", {
    securityGroupId: sg_egress.id,
    cidrIpv4: "0.0.0.0/0",
    ipProtocol: "-1",
  });


// ----EKS----  


const cluster = new eks.Cluster("cluster", {
    vpcId: main.id,
    instanceType: "t2.micro",
    publicSubnetIds: pub_sub.map(sub => sub.id),
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 2,
});


const provider = new k8s.Provider("provider", {
    kubeconfig: cluster.kubeconfig,
});


const argocdChart = new k8s.helm.v3.Chart("argocd", {
    chart: "argo-cd",
    version: "3.2.3", // Use the version compatible with your requirements
    namespace: "argocd", // Default namespace for ArgoCD
    fetchOpts: {
        repo: "https://argoproj.github.io/argo-helm", // Official ArgoCD helm chart repository
    },
}, { provider });

// Export the ArgoCD server URL for easy access.
export const argocdServer = cluster.endpoint.apply(endpoint => `https://${endpoint}`);


