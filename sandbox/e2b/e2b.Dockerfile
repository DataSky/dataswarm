FROM e2bdev/code-interpreter:latest

ENV DATASWARM_SANDBOX_TEMPLATE=dataswarm-agent-runtime
ENV DATASWARM_SANDBOX_AGENT_PROTOCOL=dataswarm.sandbox-agent.v1
ENV DATASWARM_SANDBOX_RUNTIME_PROTOCOL=dataswarm.sandbox-runtime.v1
ENV PYTHONPATH=/home/user/dataswarm

WORKDIR /home/user/dataswarm

COPY agent/dataswarm_sandbox_agent.py /home/user/dataswarm/dataswarm_sandbox_agent.py
COPY e2b/entrypoint.py /home/user/dataswarm/entrypoint.py

RUN python /home/user/dataswarm/entrypoint.py --ready
